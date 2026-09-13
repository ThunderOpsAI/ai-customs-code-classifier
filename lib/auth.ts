import crypto from 'crypto';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import { NextResponse } from 'next/server';
import { pool as defaultPool } from './db';

export interface AuthContext {
  account_id: string;
  prefix: 'prod' | 'test';
  key_id: string;
}

export type AuthResult =
  | { success: true; context: AuthContext }
  | { success: false; response: NextResponse };

interface RateLimiterState {
  timestamps: number[];
}

const rateLimitMap = new Map<string, RateLimiterState>();

export function checkRateLimit(
  keyId: string,
  prefix: 'prod' | 'test'
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = prefix === 'prod' ? 60 : 120;

  let state = rateLimitMap.get(keyId);
  if (!state) {
    state = { timestamps: [] };
    rateLimitMap.set(keyId, state);
  }

  // Filter out timestamps outside window
  state.timestamps = state.timestamps.filter((ts) => ts > now - windowMs);

  if (state.timestamps.length >= limit) {
    const oldest = state.timestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { allowed: false, retryAfter: retryAfterSeconds };
  }

  state.timestamps.push(now);
  return { allowed: true };
}

export function resetRateLimits(): void {
  rateLimitMap.clear();
}

export function computeFingerprint(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export async function authenticateRequest(
  req: Request,
  dbPool: Pool = defaultPool
): Promise<AuthResult> {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!authHeader) {
    return {
      success: false,
      response: NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header.' } },
        { status: 401 }
      ),
    };
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return {
      success: false,
      response: NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid Authorization header format. Expected Bearer <key>.' } },
        { status: 401 }
      ),
    };
  }

  const token = match[1].trim();
  if (!token.startsWith('prod_') && !token.startsWith('test_')) {
    return {
      success: false,
      response: NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid API key format.' } },
        { status: 401 }
      ),
    };
  }

  try {
    const fingerprint = computeFingerprint(token);
    const { rows } = await dbPool.query<{
      id: string;
      account_id: string;
      key_hash: string;
      prefix: 'prod' | 'test';
    }>(
      `SELECT id, account_id, key_hash, prefix
FROM api_keys
WHERE key_fingerprint = $1 AND revoked_at IS NULL
LIMIT 1`,
      [fingerprint]
    );

    if (rows.length === 0) {
      return {
        success: false,
        response: NextResponse.json(
          { error: { code: 'UNAUTHORIZED', message: 'Invalid API key.' } },
          { status: 401 }
        ),
      };
    }

    const row = rows[0];
    const isMatch = await bcrypt.compare(token, row.key_hash);
    if (!isMatch) {
      return {
        success: false,
        response: NextResponse.json(
          { error: { code: 'UNAUTHORIZED', message: 'Invalid API key.' } },
          { status: 401 }
        ),
      };
    }

    const matchedKey = row;

    // Rate limiting
    const rateCheck = checkRateLimit(matchedKey.id, matchedKey.prefix);
    if (!rateCheck.allowed) {
      return {
        success: false,
        response: NextResponse.json(
          { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded' } },
          {
            status: 429,
            headers: {
              'Retry-After': String(rateCheck.retryAfter ?? 60),
            },
          }
        ),
      };
    }

    // Update last_used_at asynchronously
    dbPool
      .query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [matchedKey.id])
      .catch((err) => {
        console.error('Failed to update last_used_at:', err);
      });

    return {
      success: true,
      context: {
        account_id: matchedKey.account_id,
        prefix: matchedKey.prefix,
        key_id: matchedKey.id,
      },
    };
  } catch (error) {
    console.error('Auth verification error:', error);
    return {
      success: false,
      response: NextResponse.json(
        { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Authentication service failure.' } },
        { status: 500 }
      ),
    };
  }
}
