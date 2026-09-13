# AI Customs Code Classifier — Owner's Production Deployment & Operations Manual

Welcome to the **AI Customs Code Classifier** operations guide. This document provides a beginner-friendly, click-by-click, step-by-step manual for launching, administering, and operating the customs code classification platform in production.

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites Checklist](#2-prerequisites-checklist)
3. [Step 1: Database Setup (Click-by-Click)](#step-1-database-setup-click-by-click)
4. [Step 2: Google AI Studio API Key (Click-by-Click)](#step-2-google-ai-studio-api-key-click-by-click)
5. [Step 3: Database Migrations & Corpus Ingestion (Run Once)](#step-3-database-migrations--corpus-ingestion-run-once)
6. [Step 4: Stripe Webhook Setup (Click-by-Click)](#step-4-stripe-webhook-setup-click-by-click)
7. [Step 5: Vercel Deployment (Click-by-Click)](#step-5-vercel-deployment-click-by-click)
8. [Step 6: Issuing API Keys & Managing Customers](#step-6-issuing-api-keys--managing-customers)
9. [Step 7: Verification & Testing Checklist](#step-7-verification--testing-checklist)
10. [Troubleshooting FAQ](#10-troubleshooting-faq)

---

## 1. Architecture Overview

The system is engineered as an enterprise-grade, low-latency microservice providing 6-digit Harmonized System (HS) code classification for e-commerce and international logistics integrators:

```
                      ┌─────────────────────────────────┐
                      │    Integrators / E-Commerce     │
                      └────────────────┬────────────────┘
                                       │ HTTPS (Bearer Token)
                                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Vercel Serverless Platform                      │
│                                                                        │
│   Next.js 14 App Router API Layer                                      │
│   ├── /v1/classify  ──> Auth & Rate Limiter (prod_ / test_)            │
│   │                     ├── [test_ key]  ──> Sandbox Deterministic Mock│
│   │                     └── [prod_ key]  ──> Atomic Credit Check       │
│   │                                          ├── Vision Captioning     │
│   │                                          ├── pgvector RAG Search   │
│   │                                          └── Gemini Reasoning LLM  │
│   ├── /v1/feedback  ──> Human-in-the-Loop Feedback Ledger              │
│   └── /api/webhooks/stripe ──> Automated Credit Top-ups                │
└───────────────┬───────────────────────────────┬────────────────────────┘
                │ SQL / pgvector                │ REST / SDK
                ▼                               ▼
  ┌───────────────────────────┐   ┌───────────────────────────────┐
  │ Managed PostgreSQL DB     │   │ Google AI Studio (Gemini)     │
  │ (Neon.tech or Supabase)   │   │ - gemini-1.5-flash (Vision)   │
  │ - pgvector (768-dim)      │   │ - text-embedding-004 (RAG)    │
  │ - 5,756 USITC HS Corpus   │   │ - gemini-1.5-flash (Decision) │
  │ - Accounts & Credits      │   └───────────────────────────────┘
  └───────────────────────────┘
```

### Core Stack Components:
- **Application Layer**: Next.js 14 (App Router) deployed globally on Vercel Serverless.
- **Database & Vector Store**: PostgreSQL with `pgvector` extension (Neon or Supabase). Stores 5,756 6-digit WCO-standard HS codes with synthetic plain-language expansions and 768-dimensional vector embeddings.
- **AI & Reasoning Engines**: Google AI Studio API:
  - `text-embedding-004` (768 dimensions, cosine similarity) for semantic retrieval.
  - `gemini-1.5-flash` for multimodal image captioning & structured classification decisions.
- **Billing & Monetization**: Prepaid credit system with automated Stripe checkout webhooks and manual CLI operator controls.

---

## 2. Prerequisites Checklist

Ensure you have created or verified accounts with the following services before starting:

| Provider | Purpose | Free Tier / Pricing | URL |
|---|---|---|---|
| **GitHub** | Source code repository and Vercel CD integration | Free | [github.com](https://github.com) |
| **Vercel** | Hosting Next.js API serverless routes | Free / Pro | [vercel.com](https://vercel.com) |
| **Neon** (or Supabase) | Managed PostgreSQL with native `pgvector` support | Free tier available | [neon.tech](https://neon.tech) |
| **Google AI Studio** | Gemini Flash & Embedding API key | Generous free tier / Pay-as-you-go | [aistudio.google.com](https://aistudio.google.com) |
| **Stripe** | Payment processing for customer credit purchases | Standard payment fees | [stripe.com](https://stripe.com) |

---

## Step 1: Database Setup (Click-by-Click)

We strongly recommend **Neon.tech** for serverless PostgreSQL with native `pgvector` support and connection pooling. Alternatively, **Supabase** works seamlessly as well.

### Recommended: Neon.tech Setup

1. Navigate to **[https://console.neon.tech/](https://console.neon.tech/)** and log in or sign up.
2. Click **Create Project**.
   - **Project Name**: `ai-customs-code-classifier` (or your preferred name).
   - **Database Name**: `neondb` (default).
   - **Region**: Select a region closest to your primary traffic (e.g., `US East (N. Virginia)` / `iad`).
   - **Postgres Version**: `16` (default).
3. Click **Create Project**.
4. Once the dashboard opens, locate the **Connection Details** card on the dashboard.
5. In the connection dropdown, select:
   - Mode: **Pooled connection** (contains `-pooler` in the hostname).
   - Language/Tool: **Node.js** or **Direct connection string**.
6. Copy the connection string. It will look like this:
   ```text
   postgres://username:password@ep-cool-butterfly-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
   > **Important Note on Connection Strings**:
   > - **Pooled Connection** (`-pooler`): Use this string for your Vercel runtime environment variables. It ensures serverless function invocations don't exhaust PostgreSQL connections.
   > - **Direct Connection** (without `-pooler`): Use this string when running database migrations or ingestion scripts from your local computer or CI/CD pipelines.

---

## Step 2: Google AI Studio API Key (Click-by-Click)

1. Open **[https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)** in your browser.
2. Sign in with your Google account.
3. Click the blue **Create API key** button.
4. Select an existing Google Cloud project or choose **Create API key in new project**.
5. Copy the generated string (starts with `AIzaSy...`).
6. Store this securely as `GEMINI_API_KEY`.

---

## Step 3: Database Migrations & Corpus Ingestion (Run Once)

Now that you have your remote `DATABASE_URL` and `GEMINI_API_KEY`, initialize the database schema and ingest the 5,756 USITC HS codes.

### 3.1 Run Database Migrations

From your terminal in the project root, execute the migration runner against your remote database:

```bash
DATABASE_URL="postgres://username:password@ep-cool-butterfly-123456.us-east-2.aws.neon.tech/neondb?sslmode=require" npx tsx db/migrate.ts
```

This applies migrations `001` through `009`:
- Enables `pgcrypto` and `vector` extensions.
- Creates `accounts`, `api_keys`, `credit_balances`, `usage_log`, `feedback_events`, and `processed_stripe_events` tables.
- Creates `hs_corpus` with 768-dimension HNSW cosine index (`idx_hs_corpus_embedding`).
- Adds `key_fingerprint` with partial index for fast O(1) key lookups.

### 3.2 Ingest the USITC HS Corpus

The ingestion script fetches the official USITC Harmonized Tariff Schedule, extracts all standard 6-digit codes, generates synthetic plain-language descriptions via LLM expansion, generates 768-dimensional embeddings via Google `text-embedding-004`, and bulk loads them into `hs_corpus`.

#### Quick Smoke Test (First 10 Codes)
To verify database connectivity and embedding generation without waiting for the full dataset:
```bash
DATABASE_URL="..." GEMINI_API_KEY="..." npx tsx scripts/load-corpus.ts --limit=10
```

#### Full Ingestion (All 5,756 HS Codes)
Run the full ingestion pipeline:
```bash
DATABASE_URL="..." GEMINI_API_KEY="..." npx tsx scripts/load-corpus.ts
```
*(The script includes automatic batching, rate limiting, and local caching in `.cache/usitc_hts_export.json` so interrupted runs resume quickly.)*

---

## Step 4: Stripe Webhook Setup (Click-by-Click)

The platform supports automated account credit top-ups via Stripe Checkout sessions.

1. Go to the **[Stripe Dashboard](https://dashboard.stripe.com/)** and log in.
2. (Optional: Ensure you are in Test mode or Live mode depending on your environment).
3. Navigate to **Developers** (top right) -> **Webhooks** (left navigation).
4. Click **Add endpoint** (or **Add destination**).
5. Configure the endpoint:
   - **Endpoint URL**: `https://<your-vercel-domain>/api/webhooks/stripe`
     *(If you haven't deployed to Vercel yet, you can add this right after Step 5, or enter your planned production domain.)*
   - **Description**: `Customs Code Classifier - Prepaid Credit Fulfillment`
   - **Events to listen to**: Click **Select events** and choose:
     `checkout.session.completed`
6. Click **Add endpoint**.
7. In the newly created webhook endpoint details page, find the **Signing secret** section.
8. Click **Reveal** and copy the secret (starts with `whsec_...`).
9. Save this string as `STRIPE_WEBHOOK_SECRET`.

### How Customers Top Up via Stripe:
When creating a Stripe Checkout Session for your customer, include the customer's `account_id` and the purchased credit amount in the session metadata:
```json
{
  "client_reference_id": "CUSTOMER_ACCOUNT_UUID",
  "metadata": {
    "account_id": "CUSTOMER_ACCOUNT_UUID",
    "credits": "500"
  }
}
```
When payment completes, the webhook handler idempotently credits their balance in `credit_balances` and records the Stripe event in `processed_stripe_events`.

---

## Step 5: Vercel Deployment (Click-by-Click)

### 5.1 Push Repository to GitHub

Ensure your local repository is committed and pushed to your GitHub account:
```bash
git add .
git commit -m "feat: production ready customs code classifier"
git push origin main
```

### 5.2 Import into Vercel

1. Go to **[https://vercel.com/dashboard](https://vercel.com/dashboard)**.
2. Click **Add New...** -> **Project**.
3. Under **Import Git Repository**, select your `ai-customs-code-classifier` repository and click **Import**.
4. Configure Project:
   - **Framework Preset**: `Next.js` (automatically selected).
   - **Root Directory**: `./` (default).
5. Expand the **Environment Variables** section and add the following 10 variables:

| Variable Name | Example / Production Value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://user:pass@ep-...-pooler.neon.tech/neondb?sslmode=require` | Use the **pooled** connection string |
| `GEMINI_API_KEY` | `AIzaSy...` | Your Google AI Studio API Key |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Stripe Webhook signing secret |
| `CONFIDENCE_FLOOR` | `0.60` | Minimum score to consider classification |
| `HIGH_CONFIDENCE_MARGIN`| `0.15` | Gap required between #1 and #2 candidate for HIGH tier |
| `MAX_MEDIUM_CANDIDATES` | `3` | Maximum alternatives returned on MEDIUM tier |
| `CANDIDATE_MIN_SCORE` | `0.60` | Minimum candidate similarity threshold |
| `RETRIEVAL_TOP_K` | `5` | Number of vector nearest neighbors fetched |
| `CAPTIONING_MODEL` | `gemini-1.5-flash` | Multimodal image captioning model |
| `CLASSIFICATION_MODEL` | `gemini-1.5-flash` | Decision reasoning model |

6. Click **Deploy**.
7. Wait ~60 seconds for the build to complete. Vercel will assign your project a production domain (e.g. `ai-customs-code-classifier.vercel.app`).

---

## Step 6: Issuing API Keys & Managing Customers

As the operator, you issue API keys and allocate prepaid credits directly via the CLI tool `scripts/create-api-key.ts`.

### 6.1 Create a Production Customer Account with Credits

Issue a live production key (`prod_`) for a customer with 500 initial credits:

```bash
DATABASE_URL="<your-database-url>" npx tsx scripts/create-api-key.ts --account="Acme Logistics Inc" --type=prod --credits=500
```

**Output:**
```text
============================================================
                 API KEY CREATED SUCCESSFULLY               
============================================================

Account Name:    Acme Logistics Inc
Account ID:      a1b2c3d4-e5f6-7890-abcd-ef1234567890 (new account)
Key ID:          f9e8d7c6-b5a4-3210-fedc-ba9876543210
Key Type:        prod
Fingerprint:     7b6a5c4d3e2f...
Credit Balance:  500 credits
Credits Added:   +500

Plaintext API Key (SAVE THIS NOW - it cannot be retrieved later):
------------------------------------------------------------
prod_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b
------------------------------------------------------------
```

> **Security Guarantee**: The raw key is hashed using `bcrypt` (10 rounds) and indexed by a SHA-256 fingerprint for O(1) constant-time lookup. It cannot be recovered from the database if lost. Provide the plaintext key to your client immediately.

### 6.2 Issue Sandbox Keys for Client Testing

Clients can test and integrate their software using a `test_` key with zero credit risk:

```bash
DATABASE_URL="<your-database-url>" npx tsx scripts/create-api-key.ts --account="Acme Logistics Inc" --type=test
```

### 6.3 Manual Credit Top-Ups

To add more credits to an existing account, re-run the command with the same account name and the desired credit amount:

```bash
DATABASE_URL="<your-database-url>" npx tsx scripts/create-api-key.ts --account="Acme Logistics Inc" --type=prod --credits=250
```
This detects the existing account and increments the credit balance by +250.

### 6.4 Credit Consumption Rules:
- **Text-Only Classification**: Deducts **1 credit** upon successful high or medium confidence classification.
- **Multimodal (Text + Image) Classification**: Deducts **2 credits** upon successful classification.
- **Low Confidence Refusals (HTTP 422)**: Deducts **0 credits**.
- **Input Validation Errors (HTTP 400)**: Deducts **0 credits**.
- **Sandbox (`test_` keys)**: Deducts **0 credits**, always.

---

## Step 7: Verification & Testing Checklist

Test your live production deployment using `curl`. Replace `https://your-domain.vercel.app` with your actual Vercel URL.

### Test 1: Sandbox Key Deterministic Stubs (Zero Cost)

Verify sandbox responses using your `test_` key:

#### A. High Confidence Match (`stainless steel mug` -> 200 OK)
```bash
curl -i -X POST "https://your-domain.vercel.app/v1/classify" \
  -H "Authorization: Bearer test_YOUR_TEST_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"description": "stainless steel mug"}'
```
*Expected: HTTP 200, `tier: "high"`, `candidates[0].hs_code: "7323.93"`, `review_recommended: false`.*

#### B. Ambiguous Item Multi-Candidate (`wireless earbuds` -> 200 OK)
```bash
curl -i -X POST "https://your-domain.vercel.app/v1/classify" \
  -H "Authorization: Bearer test_YOUR_TEST_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"description": "wireless earbuds"}'
```
*Expected: HTTP 200, `tier: "medium"`, `review_recommended: true`, two candidates (`8517.62` and `8518.30`).*

#### C. Garbage / Insufficient Detail Refusal (`mystery item` -> 422 Unprocessable Entity)
```bash
curl -i -X POST "https://your-domain.vercel.app/v1/classify" \
  -H "Authorization: Bearer test_YOUR_TEST_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"description": "mystery item"}'
```
*Expected: HTTP 422, `error.code: "INSUFFICIENT_DETAIL"`.*

---

### Test 2: Live Production Endpoint (`prod_` Key)

#### A. Text-Only Classification (Deducts 1 Credit)
```bash
curl -i -X POST "https://your-domain.vercel.app/v1/classify" \
  -H "Authorization: Bearer prod_YOUR_PROD_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"description": "100% combed cotton crewneck t-shirt short sleeve"}'
```
*Expected: HTTP 200, realistic HS code (e.g. `6109.10`), explanation rationale, confidence score > 0.60.*

#### B. Multimodal Image Classification (Deducts 2 Credits)
```bash
curl -i -X POST "https://your-domain.vercel.app/v1/classify" \
  -H "Authorization: Bearer prod_YOUR_PROD_KEY_HERE" \
  -F "description=Ceramic coffee mug with glazed finish" \
  -F "image=@/path/to/local/sample-mug.jpg;type=image/jpeg"
```
*Expected: HTTP 200, vision model extracts features and classifies under ceramic tableware (e.g. `6912.00`).*

---

### Test 3: Human Feedback Submission (`POST /v1/feedback`)

Integrators can submit human corrections to improve future retrieval accuracy:

```bash
curl -i -X POST "https://your-domain.vercel.app/v1/feedback" \
  -H "Authorization: Bearer prod_YOUR_PROD_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "classification_id": "PASTE_CLASSIFICATION_ID_FROM_PREVIOUS_RESPONSE",
    "selected_hs_code": "6109.10",
    "none_correct": false
  }'
```
*Expected: HTTP 204 No Content.*

---

## 10. Troubleshooting FAQ

### Q1: Database error `type "vector" does not exist`
**Cause**: The PostgreSQL `vector` extension is not enabled in your database.  
**Fix**: Connect to your database console (Neon SQL Editor or Supabase SQL Editor) and run:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```
Then re-run the migration script: `DATABASE_URL="..." npx tsx db/migrate.ts`.

---

### Q2: Vercel Function Timeout (504 Gateway Timeout)
**Cause**: Image captioning or embedding generation exceeded the serverless function timeout limit.  
**Fix**:
1. Check that your Vercel project settings or route configuration has `export const maxDuration = 30;` or `60`.
2. Check Google AI Studio status and API quota limits.

---

### Q3: HTTP 429 Too Many Requests
**Cause**: Rate limit exceeded for the API key.  
**Limits**:
- `prod_` keys: **60 requests / minute**
- `test_` keys: **120 requests / minute**  
**Fix**: Inspect the response header `Retry-After: <seconds>` and ensure clients implement exponential backoff with jitter.

---

### Q4: HTTP 401 Unauthorized (`Invalid API key` or `Missing Authorization header`)
**Cause**:
- Authorization header is missing or not formatted as `Bearer <key>`.
- The key prefix is neither `prod_` nor `test_`.
- The API key was revoked or does not match the database bcrypt hash.  
**Fix**: Ensure your request includes `-H "Authorization: Bearer prod_..."` and that the key was generated with `create-api-key.ts`.

---

### Q5: HTTP 402 Payment Required (`Insufficient credits`)
**Cause**: The account has 0 available credits.  
**Fix**:
- Add credits via CLI:
  ```bash
  DATABASE_URL="..." npx tsx scripts/create-api-key.ts --account="Tenant Name" --type=prod --credits=100
  ```
- Or trigger a Stripe checkout session targeting the account's UUID.

---

### Q6: Database Connection Pool Exhaustion in Serverless
**Cause**: Next.js serverless functions opening too many concurrent direct connections to Postgres.  
**Fix**: Make sure the `DATABASE_URL` in Vercel uses Neon's **pooled connection string** (contains `-pooler` in the host name).
