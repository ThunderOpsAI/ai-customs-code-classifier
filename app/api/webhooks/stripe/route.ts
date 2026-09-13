import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { pool } from '@/lib/db';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2024-09-30.acacia' as any,
});

export async function POST(req: Request) {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Failed to read request body.' } },
      { status: 400 }
    );
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers.get('stripe-signature');
  let event: Stripe.Event;

  if (webhookSecret && signature) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (sigErr: any) {
      console.error('Stripe webhook signature verification failed:', sigErr?.message);
      return NextResponse.json(
        { error: { code: 'INVALID_SIGNATURE', message: 'Stripe signature verification failed.' } },
        { status: 400 }
      );
    }
  } else {
    try {
      event = JSON.parse(rawBody) as Stripe.Event;
    } catch (parseErr) {
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'Invalid JSON payload.' } },
        { status: 400 }
      );
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const accountId = session.metadata?.account_id || session.client_reference_id;
    const rawCredits = session.metadata?.credits || session.metadata?.quantity;
    const credits = rawCredits ? parseInt(rawCredits, 10) : 0;

    if (!accountId) {
      console.warn(`Stripe session ${session.id} missing account_id.`);
      return NextResponse.json({ received: true, warning: 'Missing account_id' });
    }

    if (isNaN(credits) || credits <= 0) {
      console.warn(`Stripe session ${session.id} has invalid credits: ${rawCredits}`);
      return NextResponse.json({ received: true, warning: 'Invalid credits' });
    }

    // Check if event was already processed (idempotency)
    const { rows: processed } = await pool.query(
      'SELECT stripe_event_id FROM processed_stripe_events WHERE stripe_event_id = $1',
      [event.id]
    );

    if (processed.length > 0) {
      return NextResponse.json({ received: true });
    }

    // Process credit purchase in a single database transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO credit_balances (account_id, credits, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (account_id)
         DO UPDATE SET credits = credit_balances.credits + EXCLUDED.credits, updated_at = now()`,
        [accountId, credits]
      );

      await client.query(
        'INSERT INTO processed_stripe_events (stripe_event_id, processed_at) VALUES ($1, now())',
        [event.id]
      );

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      console.error('Failed to credit account for Stripe event:', txErr);
      return NextResponse.json(
        { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to apply credits.' } },
        { status: 500 }
      );
    } finally {
      client.release();
    }
  }

  return NextResponse.json({ received: true });
}
