import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { computeFingerprint } from '../lib/auth';

/**
 * Clean all dynamic application data from PostgreSQL tables.
 * Preserves reference tables such as hs_corpus.
 */
export async function cleanDatabase(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE TABLE feedback_events, usage_log, credit_balances, api_keys, accounts, processed_stripe_events CASCADE'
  );
}

export interface SeedAccountOptions {
  id?: string;
  name?: string;
  email?: string;
  credits?: number;
}

export async function seedAccount(
  pool: Pool,
  options?: SeedAccountOptions
): Promise<{ id: string; name: string; email: string; credits: number }> {
  const id = options?.id || uuidv4();
  const name = options?.name || `Test Account ${id.slice(0, 8)}`;
  const email = options?.email || `test-${id.slice(0, 8)}@example.com`;
  const credits = options?.credits !== undefined ? options.credits : 0;

  await pool.query(
    'INSERT INTO accounts (id, name, email) VALUES ($1, $2, $3)',
    [id, name, email]
  );

  await pool.query(
    'INSERT INTO credit_balances (account_id, credits) VALUES ($1, $2)',
    [id, credits]
  );

  return { id, name, email, credits };
}

export interface SeedApiKeyOptions {
  id?: string;
  rawKey?: string;
  revoked?: boolean;
}

export async function seedApiKey(
  pool: Pool,
  accountId: string,
  prefix: 'prod' | 'test',
  options?: SeedApiKeyOptions
): Promise<{ id: string; rawKey: string; keyHash: string; prefix: 'prod' | 'test' }> {
  const id = options?.id || uuidv4();
  const rawKey = options?.rawKey || `${prefix}_${uuidv4().replace(/-/g, '')}`;
  // Use salt rounds 4 for fast test execution
  const keyHash = await bcrypt.hash(rawKey, 4);
  const revokedAt = options?.revoked ? new Date() : null;
  const keyFingerprint = computeFingerprint(rawKey);

  await pool.query(
    `INSERT INTO api_keys (id, account_id, key_hash, prefix, revoked_at, key_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, accountId, keyHash, prefix, revokedAt, keyFingerprint]
  );

  return { id, rawKey, keyHash, prefix };
}

export interface SeedUsageLogOptions {
  creditsDeducted?: number;
  status?: string;
  tier?: string;
  imageIncluded?: boolean;
  descriptionHash?: string;
  latencyMs?: number;
}

export async function seedUsageLog(
  pool: Pool,
  accountId: string,
  classificationId: string,
  options?: SeedUsageLogOptions
): Promise<{ id: string; classificationId: string }> {
  const id = uuidv4();
  const creditsDeducted = options?.creditsDeducted ?? 1;
  const status = options?.status ?? 'success';
  const tier = options?.tier ?? 'high';
  const imageIncluded = options?.imageIncluded ?? false;
  const descriptionHash = options?.descriptionHash ?? 'hash123';
  const latencyMs = options?.latencyMs ?? 150;

  await pool.query(
    `INSERT INTO usage_log (
       id,
       account_id,
       classification_id,
       credits_deducted,
       status,
       tier,
       image_included,
       description_hash,
       latency_ms
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      accountId,
      classificationId,
      creditsDeducted,
      status,
      tier,
      imageIncluded,
      descriptionHash,
      latencyMs,
    ]
  );

  return { id, classificationId };
}
