import { Pool } from 'pg';
import crypto from 'crypto';

export function hashDescription(description: string): string {
  return crypto.createHash('sha256').update(description).digest('hex');
}

export interface LogUsageData {
  accountId: string;
  classificationId: string;
  creditsDeducted: number;
  status: string;
  tier?: string | null;
  imageIncluded: boolean;
  descriptionHash: string;
  latencyMs: number;
}

/**
 * Pre-pipeline check for available credits.
 * If credits < cost, returns false.
 */
export async function checkCreditBalance(
  accountId: string,
  cost: number,
  pool: Pool
): Promise<boolean> {
  const { rows } = await pool.query<{ credits: number }>(
    'SELECT credits FROM credit_balances WHERE account_id = $1',
    [accountId]
  );

  if (rows.length === 0) {
    return false;
  }

  return rows[0].credits >= cost;
}

/**
 * Atomic credit deduction.
 * Prevents overdraft on concurrent requests.
 * Returns the updated balance, or null if insufficient credits.
 */
export async function deductCredits(
  accountId: string,
  cost: number,
  pool: Pool
): Promise<number | null> {
  const { rows } = await pool.query<{ credits: number }>(
    `UPDATE credit_balances
     SET credits = credits - $1,
         updated_at = now()
     WHERE account_id = $2
       AND credits >= $1
     RETURNING credits`,
    [cost, accountId]
  );

  if (rows.length === 0) {
    return null;
  }

  return rows[0].credits;
}

/**
 * Failure rollback: Compensating transaction if API fails after deduction.
 * Re-credits the account and updates usage_log to status = 'refunded'.
 */
export async function refundCredits(
  accountId: string,
  cost: number,
  classificationId: string,
  pool: Pool
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE credit_balances
       SET credits = credits + $1,
           updated_at = now()
       WHERE account_id = $2`,
      [cost, accountId]
    );
    await client.query(
      `UPDATE usage_log
       SET status = 'refunded'
       WHERE classification_id = $1`,
      [classificationId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Records a classification attempt in the append-only usage_log ledger.
 */
export async function logUsage(
  data: LogUsageData,
  pool: Pool
): Promise<void> {
  await pool.query(
    `INSERT INTO usage_log (
       account_id,
       classification_id,
       credits_deducted,
       status,
       tier,
       image_included,
       description_hash,
       latency_ms
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (classification_id)
     DO UPDATE SET
       credits_deducted = EXCLUDED.credits_deducted,
       status = EXCLUDED.status,
       tier = EXCLUDED.tier,
       latency_ms = EXCLUDED.latency_ms`,
    [
      data.accountId,
      data.classificationId,
      data.creditsDeducted,
      data.status,
      data.tier ?? null,
      data.imageIncluded,
      data.descriptionHash,
      data.latencyMs,
    ]
  );
}
