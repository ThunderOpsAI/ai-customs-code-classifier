import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import {
  authenticateRequest,
  checkRateLimit,
  resetRateLimits,
} from '../lib/auth';
import { handleSandbox, SANDBOX_NAMESPACE } from '../lib/sandbox';
import {
  checkCreditBalance,
  deductCredits,
  refundCredits,
  hashDescription,
} from '../lib/billing';
import { POST as classifyHandler } from '../app/api/v1/classify/route';
import { POST as feedbackHandler } from '../app/api/v1/feedback/route';
import { POST as stripeWebhookHandler } from '../app/api/webhooks/stripe/route';

describe('Phase 4: Auth, Rate Limiting, Sandbox, Billing & API Routes', () => {
  describe('1. Sandbox Handler (lib/sandbox.ts)', () => {
    test('stainless steel mug returns HIGH tier with canned candidate', () => {
      const result = handleSandbox('stainless steel mug');
      expect(result.status).toBe(200);
      if (result.status === 200) {
        expect(result.tier).toBe('high');
        expect(result.body.review_recommended).toBe(false);
        expect(result.body.candidates).toHaveLength(1);
        expect(result.body.candidates[0].hs_code).toBe('7323.93');
        expect(result.body.candidates[0].confidence_score).toBe(0.88);
        expect(result.body.classification_id).toBe(
          uuidv5('stainless steel mug', SANDBOX_NAMESPACE)
        );
      }
    });

    test('cotton t-shirt returns HIGH tier with canned candidate', () => {
      const result = handleSandbox('  Cotton T-Shirt  ');
      expect(result.status).toBe(200);
      if (result.status === 200) {
        expect(result.tier).toBe('high');
        expect(result.body.review_recommended).toBe(false);
        expect(result.body.candidates).toHaveLength(1);
        expect(result.body.candidates[0].hs_code).toBe('6109.10');
        expect(result.body.candidates[0].confidence_score).toBe(0.85);
      }
    });

    test('wireless earbuds returns MEDIUM tier with 2 candidates', () => {
      const result = handleSandbox('wireless earbuds');
      expect(result.status).toBe(200);
      if (result.status === 200) {
        expect(result.tier).toBe('medium');
        expect(result.body.review_recommended).toBe(true);
        expect(result.body.candidates).toHaveLength(2);
        expect(result.body.candidates[0].confidence_score).toBe(0.74);
        expect(result.body.candidates[1].confidence_score).toBe(0.68);
      }
    });

    test('mystery item returns 422 refusal with INSUFFICIENT_DETAIL', () => {
      const result = handleSandbox('mystery item');
      expect(result.status).toBe(422);
      expect(result.tier).toBe('low');
      if (result.status === 422) {
        expect(result.body.error.code).toBe('INSUFFICIENT_DETAIL');
        expect(result.body.classification_id).toBe(
          uuidv5('mystery item', SANDBOX_NAMESPACE)
        );
      }
    });

    test('arbitrary input returns default MEDIUM tier with 2 fallback candidates', () => {
      const result = handleSandbox('industrial mechanical pump');
      expect(result.status).toBe(200);
      if (result.status === 200) {
        expect(result.tier).toBe('medium');
        expect(result.body.review_recommended).toBe(true);
        expect(result.body.candidates).toHaveLength(2);
        expect(result.body.classification_id).toBe(
          uuidv5('industrial mechanical pump', SANDBOX_NAMESPACE)
        );
      }
    });
  });

  describe('2. Auth Middleware & Rate Limiting (lib/auth.ts)', () => {
    beforeEach(() => {
      resetRateLimits();
    });

    test('rejects request with missing Authorization header (401)', async () => {
      const req = new Request('http://localhost/api/v1/classify', {
        method: 'POST',
      });
      const result = await authenticateRequest(req, {} as Pool);
      expect(result.success).toBe(false);
      if (!result.success) {
        const json = await result.response.json();
        expect(result.response.status).toBe(401);
        expect(json.error.code).toBe('UNAUTHORIZED');
      }
    });

    test('rejects request with malformed Authorization header (401)', async () => {
      const req = new Request('http://localhost/api/v1/classify', {
        method: 'POST',
        headers: { Authorization: 'Basic some-base64' },
      });
      const result = await authenticateRequest(req, {} as Pool);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.response.status).toBe(401);
      }
    });

    test('rejects request without prod_ or test_ prefix (401)', async () => {
      const req = new Request('http://localhost/api/v1/classify', {
        method: 'POST',
        headers: { Authorization: 'Bearer live_12345678' },
      });
      const result = await authenticateRequest(req, {} as Pool);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.response.status).toBe(401);
      }
    });

    test('rejects fabricated test_ key not found or matching in DB (401)', async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              id: 'key-1',
              account_id: 'acc-1',
              key_hash: await bcrypt.hash('test_real_valid_key', 4),
              prefix: 'test',
            },
          ],
        }),
      } as unknown as Pool;

      const req = new Request('http://localhost/api/v1/classify', {
        method: 'POST',
        headers: { Authorization: 'Bearer test_fake_fabricated_key' },
      });

      const result = await authenticateRequest(req, mockPool);
      expect(result.success).toBe(false);
      if (!result.success) {
        const json = await result.response.json();
        expect(result.response.status).toBe(401);
        expect(json.error.code).toBe('UNAUTHORIZED');
      }
    });

    test('authenticates valid test_ key successfully', async () => {
      const testKey = 'test_valid_secret_key_123';
      const keyHash = await bcrypt.hash(testKey, 4);

      const mockPool = {
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('SELECT')) {
            return Promise.resolve({
              rows: [
                {
                  id: 'key-test-1',
                  account_id: 'acc-123',
                  key_hash: keyHash,
                  prefix: 'test',
                },
              ],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
      } as unknown as Pool;

      const req = new Request('http://localhost/api/v1/classify', {
        method: 'POST',
        headers: { Authorization: `Bearer ${testKey}` },
      });

      const result = await authenticateRequest(req, mockPool);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.context.account_id).toBe('acc-123');
        expect(result.context.prefix).toBe('test');
        expect(result.context.key_id).toBe('key-test-1');
      }
    });

    test('enforces rate limiting (60/min for prod, 120/min for test)', () => {
      const prodKeyId = 'prod-key-1';
      for (let i = 0; i < 60; i++) {
        const check = checkRateLimit(prodKeyId, 'prod');
        expect(check.allowed).toBe(true);
      }
      // 61st request should be rejected
      const rateExceeded = checkRateLimit(prodKeyId, 'prod');
      expect(rateExceeded.allowed).toBe(false);
      expect(rateExceeded.retryAfter).toBeGreaterThan(0);

      // Test key has 120 limit
      const testKeyId = 'test-key-1';
      for (let i = 0; i < 120; i++) {
        const check = checkRateLimit(testKeyId, 'test');
        expect(check.allowed).toBe(true);
      }
      const testRateExceeded = checkRateLimit(testKeyId, 'test');
      expect(testRateExceeded.allowed).toBe(false);
    });
  });

  describe('3. Billing Operations (lib/billing.ts)', () => {
    test('checkCreditBalance verifies credits >= cost', async () => {
      const mockPool = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rows: [{ credits: 5 }] })
          .mockResolvedValueOnce({ rows: [{ credits: 1 }] })
          .mockResolvedValueOnce({ rows: [] }),
      } as unknown as Pool;

      expect(await checkCreditBalance('acc-1', 2, mockPool)).toBe(true);
      expect(await checkCreditBalance('acc-1', 2, mockPool)).toBe(false);
      expect(await checkCreditBalance('acc-unknown', 1, mockPool)).toBe(false);
    });

    test('deductCredits atomically updates credits and returns remaining or null', async () => {
      const mockPool = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rows: [{ credits: 9 }] })
          .mockResolvedValueOnce({ rows: [] }),
      } as unknown as Pool;

      const remaining = await deductCredits('acc-1', 1, mockPool);
      expect(remaining).toBe(9);

      const failedDeduction = await deductCredits('acc-1', 1, mockPool);
      expect(failedDeduction).toBeNull();
    });

    test('refundCredits executes compensating transaction', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      };
      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      } as unknown as Pool;

      await refundCredits('acc-1', 2, 'class-uuid-1', mockPool);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE credit_balances'),
        [2, 'acc-1']
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE usage_log\n       SET status = 'refunded'"),
        ['class-uuid-1']
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('hashDescription produces consistent SHA-256', () => {
      const hash1 = hashDescription('stainless steel mug');
      const hash2 = hashDescription('stainless steel mug');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });
  });

  describe('4. Classify Route (app/api/v1/classify/route.ts)', () => {
    let testKey: string;
    let testKeyHash: string;
    let prodKey: string;
    let prodKeyHash: string;

    beforeAll(async () => {
      testKey = 'test_sandbox_secret_999';
      testKeyHash = await bcrypt.hash(testKey, 4);
      prodKey = 'prod_live_secret_888';
      prodKeyHash = await bcrypt.hash(prodKey, 4);
    });

    beforeEach(() => {
      resetRateLimits();
      jest.restoreAllMocks();
    });

    test('rejects fabricated test_ key with 401', async () => {
      const { pool } = await import('../lib/db');
      jest.spyOn(pool, 'query').mockImplementation((async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('SELECT id, account_id, key_hash')) {
          return {
            rows: [
              {
                id: 'key-1',
                account_id: 'acc-1',
                key_hash: testKeyHash,
                prefix: 'test',
              },
            ],
          };
        }
        return { rows: [] };
      }) as any);

      const req = new Request('http://localhost/api/v1/classify', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test_fabricated_bogus_key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description: 'stainless steel mug' }),
      });

      const res = await classifyHandler(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    test('routes valid test_ key to sandbox and returns 200 for stainless steel mug', async () => {
      const { pool } = await import('../lib/db');
      jest.spyOn(pool, 'query').mockImplementation((async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('SELECT id, account_id, key_hash')) {
          return {
            rows: [
              {
                id: 'key-1',
                account_id: 'acc-1',
                key_hash: testKeyHash,
                prefix: 'test',
              },
            ],
          };
        }
        return { rows: [] };
      }) as any);

      const req = new Request('http://localhost/api/v1/classify', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description: 'stainless steel mug' }),
      });

      const res = await classifyHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.tier).toBe('high');
      expect(json.review_recommended).toBe(false);
      expect(json.candidates[0].hs_code).toBe('7323.93');
    });

    test('routes valid test_ key to sandbox and returns 422 refusal for mystery item', async () => {
      const { pool } = await import('../lib/db');
      jest.spyOn(pool, 'query').mockImplementation((async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('SELECT id, account_id, key_hash')) {
          return {
            rows: [
              {
                id: 'key-1',
                account_id: 'acc-1',
                key_hash: testKeyHash,
                prefix: 'test',
              },
            ],
          };
        }
        return { rows: [] };
      }) as any);

      const req = new Request('http://localhost/api/v1/classify', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description: 'mystery item' }),
      });

      const res = await classifyHandler(req);
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error.code).toBe('INSUFFICIENT_DETAIL');
      expect(json.classification_id).toBeDefined();
    });

    test('returns 400 VALIDATION_ERROR when description is too short', async () => {
      const { pool } = await import('../lib/db');
      jest.spyOn(pool, 'query').mockImplementation((async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('SELECT id, account_id, key_hash')) {
          return {
            rows: [
              {
                id: 'key-1',
                account_id: 'acc-1',
                key_hash: testKeyHash,
                prefix: 'test',
              },
            ],
          };
        }
        return { rows: [] };
      }) as any);

      const req = new Request('http://localhost/api/v1/classify', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description: 'short' }),
      });

      const res = await classifyHandler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    test('prod key returns 402 INSUFFICIENT_CREDITS if credit balance is 0', async () => {
      const { pool } = await import('../lib/db');
      jest.spyOn(pool, 'query').mockImplementation((async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('SELECT id, account_id, key_hash')) {
          return {
            rows: [
              {
                id: 'key-prod-1',
                account_id: 'acc-prod-1',
                key_hash: prodKeyHash,
                prefix: 'prod',
              },
            ],
          };
        }
        if (typeof sql === 'string' && sql.includes('SELECT credits FROM credit_balances')) {
          return { rows: [{ credits: 0 }] };
        }
        return { rows: [] };
      }) as any);

      const req = new Request('http://localhost/api/v1/classify', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${prodKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description: 'custom steel insulated tumbler mug' }),
      });

      const res = await classifyHandler(req);
      expect(res.status).toBe(402);
      const json = await res.json();
      expect(json.error.code).toBe('INSUFFICIENT_CREDITS');
    });
  });

  describe('5. Feedback Endpoint (app/api/v1/feedback/route.ts)', () => {
    let validKey: string;
    let keyHash: string;

    beforeAll(async () => {
      validKey = 'prod_feedback_test_123';
      keyHash = await bcrypt.hash(validKey, 4);
    });

    beforeEach(() => {
      resetRateLimits();
      jest.restoreAllMocks();
    });

    test('validates payload fields (classification_id UUID, none_correct, correction / selected_hs_code)', async () => {
      const { pool } = await import('../lib/db');
      jest.spyOn(pool, 'query').mockImplementation((async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('SELECT id, account_id, key_hash')) {
          return {
            rows: [
              {
                id: 'key-fb-1',
                account_id: 'acc-fb-1',
                key_hash: keyHash,
                prefix: 'prod',
              },
            ],
          };
        }
        return { rows: [] };
      }) as any);

      const req = new Request('http://localhost/api/v1/feedback', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          classification_id: 'invalid-uuid',
          none_correct: false,
          selected_hs_code: '7323.93',
        }),
      });

      const res = await feedbackHandler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns 400 if none_correct is true but correction is missing', async () => {
      const { pool } = await import('../lib/db');
      jest.spyOn(pool, 'query').mockImplementation((async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('SELECT id, account_id, key_hash')) {
          return {
            rows: [
              {
                id: 'key-fb-1',
                account_id: 'acc-fb-1',
                key_hash: keyHash,
                prefix: 'prod',
              },
            ],
          };
        }
        return { rows: [] };
      }) as any);

      const req = new Request('http://localhost/api/v1/feedback', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          classification_id: uuidv4(),
          none_correct: true,
        }),
      });

      const res = await feedbackHandler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns 404 if classification_id is not found for account', async () => {
      const { pool } = await import('../lib/db');
      jest.spyOn(pool, 'query').mockImplementation((async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('SELECT id, account_id, key_hash')) {
          return {
            rows: [
              {
                id: 'key-fb-1',
                account_id: 'acc-fb-1',
                key_hash: keyHash,
                prefix: 'prod',
              },
            ],
          };
        }
        if (typeof sql === 'string' && sql.includes('SELECT id FROM usage_log')) {
          return { rows: [] };
        }
        return { rows: [] };
      }) as any);

      const req = new Request('http://localhost/api/v1/feedback', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          classification_id: uuidv4(),
          none_correct: false,
          selected_hs_code: '7323.93',
        }),
      });

      const res = await feedbackHandler(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('NOT_FOUND');
    });

    test('returns 409 if feedback was already submitted', async () => {
      const { pool } = await import('../lib/db');
      const testUuid = uuidv4();
      jest.spyOn(pool, 'query').mockImplementation((async (sql: any) => {
        if (typeof sql === 'string' && sql.includes('SELECT id, account_id, key_hash')) {
          return {
            rows: [
              {
                id: 'key-fb-1',
                account_id: 'acc-fb-1',
                key_hash: keyHash,
                prefix: 'prod',
              },
            ],
          };
        }
        if (typeof sql === 'string' && sql.includes('SELECT id FROM usage_log')) {
          return { rows: [{ id: 'usage-1' }] };
        }
        if (typeof sql === 'string' && sql.includes('SELECT id FROM feedback_events')) {
          return { rows: [{ id: 'existing-feedback-1' }] };
        }
        return { rows: [] };
      }) as any);

      const req = new Request('http://localhost/api/v1/feedback', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          classification_id: testUuid,
          none_correct: false,
          selected_hs_code: '7323.93',
        }),
      });

      const res = await feedbackHandler(req);
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe('CONFLICT');
    });

    test('returns 204 on successful feedback submission', async () => {
      const { pool } = await import('../lib/db');
      const testUuid = uuidv4();
      const insertMock = jest.fn().mockResolvedValue({ rows: [] });

      jest.spyOn(pool, 'query').mockImplementation((async (sql: any, params: any) => {
        if (typeof sql === 'string' && sql.includes('SELECT id, account_id, key_hash')) {
          return {
            rows: [
              {
                id: 'key-fb-1',
                account_id: 'acc-fb-1',
                key_hash: keyHash,
                prefix: 'prod',
              },
            ],
          };
        }
        if (typeof sql === 'string' && sql.includes('SELECT id FROM usage_log')) {
          return { rows: [{ id: 'usage-1' }] };
        }
        if (typeof sql === 'string' && sql.includes('SELECT id FROM feedback_events')) {
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO feedback_events')) {
          return insertMock(sql, params);
        }
        return { rows: [] };
      }) as any);

      const req = new Request('http://localhost/api/v1/feedback', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          classification_id: testUuid,
          none_correct: true,
          correction: 'Actual code is 7323.99',
        }),
      });

      const res = await feedbackHandler(req);
      expect(res.status).toBe(204);
      expect(insertMock).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO feedback_events'),
        [testUuid, 'acc-fb-1', null, true, 'Actual code is 7323.99']
      );
    });
  });

  describe('6. Stripe Webhook Endpoint (app/api/webhooks/stripe/route.ts)', () => {
    beforeEach(() => {
      jest.restoreAllMocks();
    });

    test('idempotently processes checkout.session.completed', async () => {
      const { pool } = await import('../lib/db');
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      };
      jest.spyOn(pool, 'connect').mockImplementation((async () => mockClient) as any);

      const eventPayload = {
        id: 'evt_test_12345',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_123',
            client_reference_id: 'acc-1234',
            metadata: {
              account_id: 'acc-1234',
              credits: '100',
            },
          },
        },
      };

      // First call: event is not in processed_stripe_events
      jest.spyOn(pool, 'query').mockImplementationOnce((async () => ({ rows: [] })) as any);

      const req1 = new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        body: JSON.stringify(eventPayload),
      });

      const res1 = await stripeWebhookHandler(req1);
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.received).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO credit_balances'),
        ['acc-1234', 100]
      );

      // Second call: event already processed
      jest
        .spyOn(pool, 'query')
        .mockImplementationOnce((async () => ({ rows: [{ stripe_event_id: 'evt_test_12345' }] })) as any);

      const req2 = new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        body: JSON.stringify(eventPayload),
      });

      const res2 = await stripeWebhookHandler(req2);
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.received).toBe(true);
    });
  });
});
