import 'dotenv/config';
import http from 'http';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '@/lib/db';
import { resetRateLimits } from '@/lib/auth';
import * as classifyModule from '@/lib/classify';
import { calculateTier, TierThresholds } from '@/lib/classify';
import { createTestServer } from './test-server';
import { cleanDatabase, seedAccount, seedApiKey, seedUsageLog } from './test-db';

describe('Phase 5: Full Integration Test Suite', () => {
  let server: http.Server;

  beforeAll(async () => {
    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await cleanDatabase(pool);
    await pool.end();
  });

  beforeEach(async () => {
    resetRateLimits();
    jest.restoreAllMocks();
    await cleanDatabase(pool);
  });

  // =========================================================================
  // A. Tier Logic Unit Tests
  // =========================================================================
  describe('A. Tier logic unit tests (pure, no DB)', () => {
    const thresholds: TierThresholds = {
      confidenceFloor: 0.6,
      highConfidenceMargin: 0.15,
    };

    test('0 results → LOW', () => {
      const scores: number[] = [];
      const tier = calculateTier(scores, thresholds);
      expect(tier).toBe('low');
    });

    test('1 result, score >= floor, margin = ∞ → HIGH', () => {
      const scores = [0.85];
      const tier = calculateTier(scores, thresholds);
      expect(tier).toBe('high');
    });

    test('1 result, score < floor → LOW', () => {
      const scores = [0.55];
      const tier = calculateTier(scores, thresholds);
      expect(tier).toBe('low');
    });

    test('2 results, margin >= threshold → HIGH', () => {
      const scores = [0.85, 0.65]; // margin = 0.20 >= 0.15, top = 0.85 >= 0.60
      const tier = calculateTier(scores, thresholds);
      expect(tier).toBe('high');
    });

    test('2 results, margin < threshold, both above CANDIDATE_MIN_SCORE → MEDIUM', () => {
      const scores = [0.75, 0.7]; // margin = 0.05 < 0.15, top = 0.75 >= 0.60
      const tier = calculateTier(scores, thresholds);
      expect(tier).toBe('medium');
    });

    test('Top score < floor → LOW', () => {
      const scores = [0.58, 0.3]; // top = 0.58 < 0.60
      const tier = calculateTier(scores, thresholds);
      expect(tier).toBe('low');
    });
  });

  // =========================================================================
  // B. Auth Integration Tests
  // =========================================================================
  describe('B. Auth integration tests (using real DB seeding and supertest)', () => {
    test('Valid prod_ key → 200 (passes auth to classify pipeline)', async () => {
      const account = await seedAccount(pool, { name: 'Prod Account', credits: 10 });
      const apiKey = await seedApiKey(pool, account.id, 'prod');

      jest.spyOn(classifyModule, 'classify').mockResolvedValueOnce({
        classification_id: uuidv4(),
        tier: 'high',
        review_recommended: false,
        country_specific_codes: null,
        candidates: [
          {
            hs_code: '7323.93',
            description: 'Table, kitchen or other household articles of stainless steel',
            rationale: 'Matches insulated tumbler description',
            confidence_score: 0.88,
          },
        ],
        image_included: false,
      });

      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${apiKey.rawKey}`)
        .send({ description: 'stainless steel insulated tumbler mug' });

      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('high');
      expect(res.body.candidates).toHaveLength(1);
    });

    test('Valid test_ key → sandbox response', async () => {
      const account = await seedAccount(pool, { name: 'Sandbox Account' });
      const apiKey = await seedApiKey(pool, account.id, 'test');

      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${apiKey.rawKey}`)
        .send({ description: 'stainless steel mug' });

      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('high');
      expect(res.body.candidates[0].hs_code).toBe('7323.93');
    });

    test('Fabricated test_abcdef key (not in DB) → 401', async () => {
      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', 'Bearer test_abcdef1234567890')
        .send({ description: 'stainless steel mug' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    test('Missing header → 401', async () => {
      const res = await request(server)
        .post('/v1/classify')
        .send({ description: 'stainless steel mug' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    test('Revoked key (in DB but revoked_at IS NOT NULL) → 401', async () => {
      const account = await seedAccount(pool, { name: 'Revoked Account' });
      const apiKey = await seedApiKey(pool, account.id, 'test', { revoked: true });

      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${apiKey.rawKey}`)
        .send({ description: 'stainless steel mug' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  // =========================================================================
  // C. Billing Integration Tests
  // =========================================================================
  describe('C. Billing integration tests (against real PostgreSQL credit_balances and usage_log)', () => {
    test('0 credits + text request with prod_ key → 402 before pipeline runs', async () => {
      const account = await seedAccount(pool, { name: 'Zero Credit Account', credits: 0 });
      const apiKey = await seedApiKey(pool, account.id, 'prod');

      const classifySpy = jest.spyOn(classifyModule, 'classify');

      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${apiKey.rawKey}`)
        .send({ description: 'stainless steel insulated tumbler mug' });

      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('INSUFFICIENT_CREDITS');
      // Verify pipeline did not execute
      expect(classifySpy).not.toHaveBeenCalled();

      // Check balance remains 0
      const { rows } = await pool.query<{ credits: number }>(
        'SELECT credits FROM credit_balances WHERE account_id = $1',
        [account.id]
      );
      expect(rows[0].credits).toBe(0);
    });

    test('Sufficient credits + text success → credits decremented by 1', async () => {
      const account = await seedAccount(pool, { name: 'Billing Text Account', credits: 5 });
      const apiKey = await seedApiKey(pool, account.id, 'prod');

      const fakeId = uuidv4();
      jest.spyOn(classifyModule, 'classify').mockResolvedValueOnce({
        classification_id: fakeId,
        tier: 'high',
        review_recommended: false,
        country_specific_codes: null,
        candidates: [
          {
            hs_code: '7323.93',
            description: 'Table, kitchen or other household articles of stainless steel',
            rationale: 'Insulated tumbler',
            confidence_score: 0.88,
          },
        ],
        image_included: false,
      });

      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${apiKey.rawKey}`)
        .send({ description: 'stainless steel insulated tumbler mug' });

      expect(res.status).toBe(200);

      // Verify credit_balances decremented by 1 (5 -> 4)
      const { rows: creditRows } = await pool.query<{ credits: number }>(
        'SELECT credits FROM credit_balances WHERE account_id = $1',
        [account.id]
      );
      expect(creditRows[0].credits).toBe(4);

      // Verify usage_log record
      const { rows: usageRows } = await pool.query<{
        credits_deducted: number;
        status: string;
        tier: string;
      }>('SELECT credits_deducted, status, tier FROM usage_log WHERE classification_id = $1', [
        fakeId,
      ]);
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0].credits_deducted).toBe(1);
      expect(usageRows[0].status).toBe('success');
      expect(usageRows[0].tier).toBe('high');
    });

    test('Sufficient credits + image success → credits decremented by 2', async () => {
      const account = await seedAccount(pool, { name: 'Billing Image Account', credits: 5 });
      const apiKey = await seedApiKey(pool, account.id, 'prod');

      const fakeId = uuidv4();
      jest.spyOn(classifyModule, 'classify').mockResolvedValueOnce({
        classification_id: fakeId,
        tier: 'high',
        review_recommended: false,
        country_specific_codes: null,
        candidates: [
          {
            hs_code: '7323.93',
            description: 'Table, kitchen or other household articles of stainless steel',
            rationale: 'Insulated tumbler with image confirmation',
            confidence_score: 0.92,
          },
        ],
        image_included: true,
      });

      // 1x1 valid transparent PNG base64
      const pngBase64 =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${apiKey.rawKey}`)
        .send({
          description: 'stainless steel insulated tumbler mug',
          image: pngBase64,
        });

      expect(res.status).toBe(200);

      // Verify credit_balances decremented by 2 (5 -> 3)
      const { rows: creditRows } = await pool.query<{ credits: number }>(
        'SELECT credits FROM credit_balances WHERE account_id = $1',
        [account.id]
      );
      expect(creditRows[0].credits).toBe(3);

      // Verify usage_log record
      const { rows: usageRows } = await pool.query<{
        credits_deducted: number;
        image_included: boolean;
      }>('SELECT credits_deducted, image_included FROM usage_log WHERE classification_id = $1', [
        fakeId,
      ]);
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0].credits_deducted).toBe(2);
      expect(usageRows[0].image_included).toBe(true);
    });

    test('LOW refusal → credits unchanged (0 credits deducted)', async () => {
      const account = await seedAccount(pool, { name: 'Low Tier Account', credits: 5 });
      const apiKey = await seedApiKey(pool, account.id, 'prod');

      const fakeId = uuidv4();
      jest.spyOn(classifyModule, 'classify').mockResolvedValueOnce({
        classification_id: fakeId,
        tier: 'low',
        review_recommended: true,
        country_specific_codes: null,
        candidates: [],
        image_included: false,
      });

      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${apiKey.rawKey}`)
        .send({ description: 'ambiguous multi-material component' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INSUFFICIENT_DETAIL');
      expect(res.body.classification_id).toBe(fakeId);

      // Verify credit_balances unchanged (still 5)
      const { rows: creditRows } = await pool.query<{ credits: number }>(
        'SELECT credits FROM credit_balances WHERE account_id = $1',
        [account.id]
      );
      expect(creditRows[0].credits).toBe(5);

      // Verify usage_log records 0 credits deducted
      const { rows: usageRows } = await pool.query<{ credits_deducted: number; tier: string }>(
        'SELECT credits_deducted, tier FROM usage_log WHERE classification_id = $1',
        [fakeId]
      );
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0].credits_deducted).toBe(0);
      expect(usageRows[0].tier).toBe('low');
    });

    test('Concurrent requests race: two simultaneous requests against account with 1 credit → exactly one succeeds, one gets 402!', async () => {
      const account = await seedAccount(pool, { name: 'Race Account', credits: 1 });
      const apiKey = await seedApiKey(pool, account.id, 'prod');

      // Mock pipeline to resolve with slight delay to ensure concurrency overlap
      jest.spyOn(classifyModule, 'classify').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return {
          classification_id: uuidv4(),
          tier: 'high',
          review_recommended: false,
          country_specific_codes: null,
          candidates: [
            {
              hs_code: '7323.93',
              description: 'Stainless item',
              rationale: 'Rationale',
              confidence_score: 0.9,
            },
          ],
          image_included: false,
        };
      });

      const req1 = request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${apiKey.rawKey}`)
        .send({ description: 'stainless steel insulated tumbler mug' });

      const req2 = request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${apiKey.rawKey}`)
        .send({ description: 'stainless steel insulated tumbler mug' });

      const [res1, res2] = await Promise.all([req1, req2]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 402]);

      // Verify credits balance is exactly 0
      const { rows } = await pool.query<{ credits: number }>(
        'SELECT credits FROM credit_balances WHERE account_id = $1',
        [account.id]
      );
      expect(rows[0].credits).toBe(0);

      // Verify only 1 usage_log record deducted credits
      const { rows: usageRows } = await pool.query<{ credits_deducted: number }>(
        'SELECT credits_deducted FROM usage_log WHERE account_id = $1',
        [account.id]
      );
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0].credits_deducted).toBe(1);
    });
  });

  // =========================================================================
  // D. Classify Endpoint Integration Tests (Sandbox test_ keys via supertest)
  // =========================================================================
  describe('D. Classify endpoint integration tests (using sandbox test_ keys via supertest)', () => {
    let testKey: string;

    beforeEach(async () => {
      const account = await seedAccount(pool, { name: 'Sandbox Suite Account' });
      const key = await seedApiKey(pool, account.id, 'test');
      testKey = key.rawKey;
    });

    test('stainless steel mug → HIGH tier, 200', async () => {
      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ description: 'stainless steel mug' });

      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('high');
      expect(res.body.review_recommended).toBe(false);
      expect(res.body.candidates).toHaveLength(1);
      expect(res.body.candidates[0].hs_code).toBe('7323.93');
      expect(res.body.candidates[0].confidence_score).toBe(0.88);
    });

    test('wireless earbuds → MEDIUM tier, 200', async () => {
      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ description: 'wireless earbuds' });

      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('medium');
      expect(res.body.review_recommended).toBe(true);
      expect(res.body.candidates).toHaveLength(2);
      expect(res.body.candidates[0].hs_code).toBe('8517.62');
      expect(res.body.candidates[1].hs_code).toBe('8518.30');
    });

    test('mystery item → LOW tier, 422, body includes classification_id', async () => {
      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ description: 'mystery item' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INSUFFICIENT_DETAIL');
      expect(res.body.classification_id).toBeDefined();
    });

    test('ab (too short) → 400 VALIDATION_ERROR', async () => {
      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ description: 'ab' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('at least 10 characters');
    });

    test('Unknown description → MEDIUM default fallback, 200', async () => {
      const res = await request(server)
        .post('/v1/classify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ description: 'industrial centrifugal chemical processing pump' });

      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('medium');
      expect(res.body.review_recommended).toBe(true);
      expect(res.body.candidates).toHaveLength(2);
      expect(res.body.classification_id).toBeDefined();
    });
  });

  // =========================================================================
  // E. Feedback Endpoint Integration Tests
  // =========================================================================
  describe('E. Feedback endpoint integration tests (using supertest against real DB)', () => {
    let accountA: { id: string; name: string };
    let apiKeyA: string;
    let classificationIdA: string;

    let accountB: { id: string; name: string };
    let apiKeyB: string;
    let classificationIdB: string;

    beforeEach(async () => {
      // Account A
      accountA = await seedAccount(pool, { name: 'Feedback Account A' });
      const keyA = await seedApiKey(pool, accountA.id, 'prod');
      apiKeyA = keyA.rawKey;
      classificationIdA = uuidv4();
      await seedUsageLog(pool, accountA.id, classificationIdA);

      // Account B
      accountB = await seedAccount(pool, { name: 'Feedback Account B' });
      const keyB = await seedApiKey(pool, accountB.id, 'prod');
      apiKeyB = keyB.rawKey;
      classificationIdB = uuidv4();
      await seedUsageLog(pool, accountB.id, classificationIdB);
    });

    test('Accept valid feedback → 204', async () => {
      const res = await request(server)
        .post('/v1/feedback')
        .set('Authorization', `Bearer ${apiKeyA}`)
        .send({
          classification_id: classificationIdA,
          none_correct: false,
          selected_hs_code: '7323.93',
        });

      expect(res.status).toBe(204);

      // Verify row in feedback_events in real database
      const { rows } = await pool.query<{
        classification_id: string;
        account_id: string;
        selected_hs_code: string;
        none_correct: boolean;
      }>('SELECT * FROM feedback_events WHERE classification_id = $1', [classificationIdA]);

      expect(rows).toHaveLength(1);
      expect(rows[0].account_id).toBe(accountA.id);
      expect(rows[0].selected_hs_code).toBe('7323.93');
      expect(rows[0].none_correct).toBe(false);
    });

    test("Wrong account's classification_id → 404", async () => {
      // Account A attempts to submit feedback on Account B's classification
      const res = await request(server)
        .post('/v1/feedback')
        .set('Authorization', `Bearer ${apiKeyA}`)
        .send({
          classification_id: classificationIdB,
          none_correct: false,
          selected_hs_code: '7323.93',
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    test('Duplicate submission for same classification_id → 409', async () => {
      // First submission
      const res1 = await request(server)
        .post('/v1/feedback')
        .set('Authorization', `Bearer ${apiKeyA}`)
        .send({
          classification_id: classificationIdA,
          none_correct: false,
          selected_hs_code: '7323.93',
        });
      expect(res1.status).toBe(204);

      // Duplicate submission
      const res2 = await request(server)
        .post('/v1/feedback')
        .set('Authorization', `Bearer ${apiKeyA}`)
        .send({
          classification_id: classificationIdA,
          none_correct: false,
          selected_hs_code: '7323.93',
        });
      expect(res2.status).toBe(409);
      expect(res2.body.error.code).toBe('CONFLICT');
    });

    test('none_correct: true without correction → 400', async () => {
      const res = await request(server)
        .post('/v1/feedback')
        .set('Authorization', `Bearer ${apiKeyA}`)
        .send({
          classification_id: classificationIdA,
          none_correct: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('correction is required');
    });

    test('none_correct: false without selected_hs_code → 400', async () => {
      const res = await request(server)
        .post('/v1/feedback')
        .set('Authorization', `Bearer ${apiKeyA}`)
        .send({
          classification_id: classificationIdA,
          none_correct: false,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('selected_hs_code is required');
    });
  });

  // =========================================================================
  // F. Stripe Webhook Integration Tests (Real DB transaction & idempotency)
  // =========================================================================
  describe('F. Stripe webhook integration tests (real DB transaction & idempotency)', () => {
    test('checkout.session.completed credits account and is idempotent', async () => {
      const account = await seedAccount(pool, { name: 'Stripe Account', credits: 0 });
      const eventId = `evt_${uuidv4().replace(/-/g, '')}`;

      const payload = {
        id: eventId,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_${uuidv4().replace(/-/g, '')}`,
            client_reference_id: account.id,
            metadata: {
              account_id: account.id,
              credits: '100',
            },
          },
        },
      };

      // First webhook call: adds 100 credits
      const res1 = await request(server)
        .post('/webhooks/stripe')
        .send(payload);

      expect(res1.status).toBe(200);
      expect(res1.body.received).toBe(true);

      const { rows: creditRows1 } = await pool.query<{ credits: number }>(
        'SELECT credits FROM credit_balances WHERE account_id = $1',
        [account.id]
      );
      expect(creditRows1[0].credits).toBe(100);

      // Verify processed_stripe_events table
      const { rows: eventRows } = await pool.query<{ stripe_event_id: string }>(
        'SELECT stripe_event_id FROM processed_stripe_events WHERE stripe_event_id = $1',
        [eventId]
      );
      expect(eventRows).toHaveLength(1);

      // Second webhook call with same event ID: idempotent, credits stay 100
      const res2 = await request(server)
        .post('/webhooks/stripe')
        .send(payload);

      expect(res2.status).toBe(200);
      expect(res2.body.received).toBe(true);

      const { rows: creditRows2 } = await pool.query<{ credits: number }>(
        'SELECT credits FROM credit_balances WHERE account_id = $1',
        [account.id]
      );
      expect(creditRows2[0].credits).toBe(100);
    });
  });
});
