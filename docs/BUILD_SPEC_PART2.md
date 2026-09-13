# HS Code Classifier API — MVP Build Spec (Part 2: API, Auth, & Billing)

## 5. Authentication & Sandbox Architecture

The API is designed for integrators (logistics software, e-commerce platforms). It uses standard Bearer token authentication with explicit sandbox boundaries.

### API Keys Data Model

- Keys MUST be stored as **salted hashes** (bcrypt or Argon2id) in the `api_keys` table. The plaintext key is shown to the user once at issuance and never stored.
- Keys are issued with explicit environment prefixes: `prod_` for live requests, `test_` for sandbox.
- The `api_keys` table must record: `account_id`, `key_hash`, `prefix` (`prod` | `test`), `created_at`, `last_used_at`, `revoked_at` (nullable).

### The Sandbox (`test_` keys)

- **Zero Cost:** Sandbox requests MUST NOT trigger live vector DB lookups, embedding calls, or LLM calls.
- **Implementation:** The auth middleware detects the `test_` prefix and routes the request to a deterministic stub handler before any pipeline code runs. All API keys — both `prod_` and `test_` prefixed — must be hash-verified against the `api_keys` table before routing to the sandbox stub. A `test_`-prefixed string that does not match a stored hash must be rejected with `401`.
- **Stub Responses:** The stub handler matches the incoming `description` (case-insensitive, trimmed) against a fixed dictionary of known entries. If no match is found, return the **default sandbox response** — a MEDIUM-tier response with two dummy candidates — so integrators always receive a parseable, realistic response shape.
- **No credits deducted** for sandbox requests, ever.

**Example canned entries (non-exhaustive):**

| Description | Response Tier |
|---|---|
| `stainless steel mug` | `high` |
| `cotton t-shirt` | `high` |
| `wireless earbuds` | `medium` |
| `mystery item` | `low` (refusal) |
| *(anything else)* | `medium` (default fallback) |

### Rate Limiting

Rate limits apply per API key, enforced at the auth middleware layer:

| Key Type | Limit |
|---|---|
| `prod_` | 60 requests / minute |
| `test_` | 120 requests / minute |

Exceeded requests return `429 Too Many Requests` with a `Retry-After` header. No credits are deducted.

---

## 6. Billing: Prepaid Credits System

MVP uses a strictly prepaid model — zero credit risk, no postpaid complexity.

### Data Model

**`accounts`** — Standard tenant table.

**`credit_balances`** — One row per account. Current available credits.

```sql
account_id  UUID PRIMARY KEY REFERENCES accounts(id)
credits     INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0)
updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
```

**`usage_log`** — Append-only ledger of every classification attempt.

```sql
id                UUID PRIMARY KEY DEFAULT gen_random_uuid()
account_id        UUID NOT NULL REFERENCES accounts(id)
classification_id UUID NOT NULL UNIQUE  -- links to the classify response
timestamp         TIMESTAMPTZ NOT NULL DEFAULT now()
credits_deducted  INTEGER NOT NULL  -- 0 on failure/sandbox, 1 or 2 on success
status            TEXT NOT NULL  -- 'success' | 'failed' | 'refunded'
tier              TEXT  -- 'high' | 'medium' | 'low' | null on failure
image_included    BOOLEAN NOT NULL DEFAULT false
description_hash  TEXT  -- SHA-256 of the input description (for analytics, not PII retrieval)
latency_ms        INTEGER  -- end-to-end pipeline latency
```

**`processed_stripe_events`** — Idempotency log for Stripe webhooks.

```sql
stripe_event_id  TEXT PRIMARY KEY
processed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
```

**`feedback_events`** — Accept/reject signal for future active learning.

```sql
id                UUID PRIMARY KEY DEFAULT gen_random_uuid()
classification_id UUID NOT NULL REFERENCES usage_log(classification_id)
account_id        UUID NOT NULL REFERENCES accounts(id)
selected_hs_code  TEXT  -- null if none_correct = true
none_correct      BOOLEAN NOT NULL DEFAULT false
correction        TEXT  -- freetext, populated when none_correct = true
created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
```

### Billing Flow

1. User purchases a credit pack via Stripe Checkout (one-time payment).
2. Stripe sends a `checkout.session.completed` webhook.
3. The webhook handler checks `processed_stripe_events` for `event.id`. If already present, return `200` immediately (idempotent — no double-credit).
4. If not present: increment `credit_balances.credits` for the account, then insert `event.id` into `processed_stripe_events` in a single transaction.
5. Every `prod_` API call:
   - Text-only: **–1 credit**
   - Image-included: **–2 credits**
   - If `credits < required_cost`: return `402 Payment Required` before running any pipeline step.
   - LOW_CONFIDENCE refusals (422) do not deduct credits.

### Credit Deduction: Atomic & Failure-Safe

**Deduction timing:** Credits are deducted *after* the pipeline completes successfully. This avoids charging users for upstream LLM failures.

**Atomic deduction (prevents overdraft on concurrent requests):**

```sql
UPDATE credit_balances
SET credits = credits - $cost,
    updated_at = now()
WHERE account_id = $account_id
  AND credits >= $cost
RETURNING credits;
```

If 0 rows are returned, another concurrent request won the race — return `402 Payment Required`.

**Failure rollback:** If the API returns a `5xx` error at any point after a credit deduction has already been made (e.g., a deduction was committed just before a crash), a compensating transaction re-credits the account and logs a `status: 'refunded'` entry in `usage_log`.

---

## 7. Core API Contracts

### A. `POST /v1/classify`

**Authentication:** `Authorization: Bearer <api_key>` (required)

**Request — multipart/form-data or application/json:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `description` | string | Yes | 10–1,000 characters |
| `image` | file / base64 | No | JPEG, PNG, WebP; max 5 MB |

**Success Response (200 OK):**

```json
{
  "classification_id": "550e8400-e29b-41d4-a716-446655440000",
  "tier": "medium",
  "review_recommended": true,
  "country_specific_codes": null,
  "candidates": [
    {
      "hs_code": "7323.93",
      "description": "Table, kitchen or other household articles, of stainless steel",
      "rationale": "The item is described as a double-walled insulated thermos, which falls under household stainless steel articles.",
      "confidence_score": 0.82
    },
    {
      "hs_code": "9617.00",
      "description": "Vacuum flasks and other vacuum vessels",
      "rationale": "A double-walled vacuum thermos is explicitly described by HS 9617.00.",
      "confidence_score": 0.71
    }
  ]
}
```

**Error Responses:**

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Missing/invalid field, description too short/long, unsupported image format, image too large |
| `401` | `UNAUTHORIZED` | Missing or invalid API key |
| `402` | `INSUFFICIENT_CREDITS` | Account balance below required cost |
| `422` | `INSUFFICIENT_DETAIL` | Low-confidence refusal — input is valid but unclassifiable |
| `429` | `RATE_LIMIT_EXCEEDED` | Per-key rate limit hit |
| `503` | `UPSTREAM_ERROR` | LLM or embedding provider timeout/failure |

**Low-confidence refusal body (422):**

```json
{
  "classification_id": "550e8400-e29b-41d4-a716-446655440000",
  "error": {
    "code": "INSUFFICIENT_DETAIL",
    "message": "Unable to classify with sufficient confidence. Please provide more material or functional details."
  }
}
```

*Note: `classification_id` is still returned on a 422 so the failure can be logged and the feedback endpoint can record a `none_correct: true` signal.*

---

### B. `POST /v1/feedback`

This endpoint captures the human-verified ground truth. Integrators call it when the seller accepts or corrects a suggestion in their UI.

**Authentication:** `Authorization: Bearer <api_key>` (required)

**Ownership check:** The `classification_id` must belong to the authenticated account. Return `404 Not Found` if it does not exist or belongs to a different account. (Using 404 rather than 403 avoids leaking whether a classification ID exists.)

**Request Payload:**

```json
{
  "classification_id": "550e8400-e29b-41d4-a716-446655440000",
  "selected_hs_code": "7323.93",
  "none_correct": false,
  "correction": ""
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `classification_id` | UUID | Yes | Must belong to the authenticated account |
| `selected_hs_code` | string | Conditional | Required if `none_correct` is false |
| `none_correct` | boolean | Yes | `true` if the seller rejected all suggestions |
| `correction` | string | Conditional | Freetext; required if `none_correct` is true |

**Success Response (204 No Content):** No body.

**Storage:** Inserts into `feedback_events`. The `none_correct` + `correction` pair is the highest-value training signal for V2 active learning. The `selected_hs_code` on accepted suggestions is the ground truth for retrieval quality measurement.

---

## 8. Error Response Envelope

All error responses use a consistent envelope:

```json
{
  "error": {
    "code": "SNAKE_CASE_ERROR_CODE",
    "message": "Human-readable description suitable for logging."
  }
}
```

Integrators should key on `code` programmatically, not on `message` (which may change).
