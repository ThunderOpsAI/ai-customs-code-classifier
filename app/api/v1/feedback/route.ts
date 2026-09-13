import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { authenticateRequest } from '@/lib/auth';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  // 1. Auth verification
  const auth = await authenticateRequest(req, pool);
  if (!auth.success) {
    return auth.response;
  }

  // 2. Parse JSON payload
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON payload.' } },
      { status: 400 }
    );
  }

  const { classification_id, selected_hs_code, none_correct, correction } = body || {};

  // 3. Validation
  if (!classification_id || typeof classification_id !== 'string' || !UUID_REGEX.test(classification_id)) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'classification_id must be a valid UUID.' } },
      { status: 400 }
    );
  }

  if (typeof none_correct !== 'boolean') {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'none_correct must be a boolean.' } },
      { status: 400 }
    );
  }

  if (!none_correct) {
    if (!selected_hs_code || typeof selected_hs_code !== 'string' || selected_hs_code.trim() === '') {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'selected_hs_code is required when none_correct is false.',
          },
        },
        { status: 400 }
      );
    }
  } else {
    if (!correction || typeof correction !== 'string' || correction.trim() === '') {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'correction is required when none_correct is true.',
          },
        },
        { status: 400 }
      );
    }
  }

  try {
    // 4. Ownership check: classification_id must belong to authenticated account
    const { rows: usageRows } = await pool.query<{ id: string }>(
      'SELECT id FROM usage_log WHERE classification_id = $1 AND account_id = $2',
      [classification_id, auth.context.account_id]
    );

    if (usageRows.length === 0) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Classification not found' } },
        { status: 404 }
      );
    }

    // 5. Duplicate check: prevent duplicate feedback
    const { rows: feedbackRows } = await pool.query<{ id: string }>(
      'SELECT id FROM feedback_events WHERE classification_id = $1',
      [classification_id]
    );

    if (feedbackRows.length > 0) {
      return NextResponse.json(
        {
          error: {
            code: 'CONFLICT',
            message: 'Feedback already submitted for this classification',
          },
        },
        { status: 409 }
      );
    }

    // 6. Insert into feedback_events
    await pool.query(
      `INSERT INTO feedback_events (
         classification_id,
         account_id,
         selected_hs_code,
         none_correct,
         correction
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        classification_id,
        auth.context.account_id,
        none_correct ? null : selected_hs_code.trim(),
        none_correct,
        none_correct ? correction.trim() : correction ? correction.trim() : null,
      ]
    );

    // 7. Success response: 204 No Content
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error('Feedback submission error:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to process feedback.' } },
      { status: 500 }
    );
  }
}
