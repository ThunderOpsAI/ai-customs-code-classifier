# HS Code Classifier API — MVP Build Spec (Part 1: Core Engine)

## 1. Product Positioning & Context

**Goal:** An API endpoint providing first-pass 6-digit Harmonized System (HS) code suggestions for e-commerce sellers during shipment and customs-document preparation.

**Liability Stance:** This is a *suggestion tool*, not an authoritative customs filing service. The design enforces this via explicit confidence scoring, multi-candidate options for ambiguous items, and refusal to classify garbage input.

**Output:** International 6-digit HS codes only (jurisdiction-agnostic). Country-specific 8–10 digit codes (HTS/TARIC) are deferred to V2. The API response schema includes a `country_specific_codes` field (set to `null` at MVP) so integrators do not need to rewrite their parsing logic when V2 ships.

---

## 2. Data Sourcing & Corpus Management

The RAG architecture relies on a highly accurate, plain-language vector corpus.

- **Source Data:** USITC published HTS data (public domain).
- **Transformation:** Truncated to the 6-digit level, which matches the international WCO standard.
- **Synthetic Expansion (Cold Start):** Raw customs jargon is expanded offline via an LLM pipeline to generate plain-language synonyms, common consumer product descriptions, and material variants.
- **Embeddings:** The *synthetic plain-language descriptions* are embedded using **Google `text-embedding-004`** (Vertex AI) with **cosine similarity** as the distance metric. All scores are in the [0, 1] range. This model and metric must be documented in the codebase; if either is changed the confidence thresholds in Section 3c **must** be recalibrated against a held-out evaluation set before deploying.
- **Maintenance:** A quarterly cron job must be scheduled to pull USITC updates, re-run synthetic expansions, and update the vector store to prevent staleness.

---

## 3. The Classification Pipeline (RAG + LLM)

Text is **required**; Image is **optional**. All input validation (Section 3.0) runs before any pipeline step and before any credits are deducted.

### Step 3.0: Input Validation (Pre-Pipeline Gate)

Validate before touching the vector DB, LLM, or billing:

| Field | Rule | Error |
|---|---|---|
| `description` | Required, string | `400 Bad Request` |
| `description` | Min 10 characters | `400 Bad Request` |
| `description` | Max 1,000 characters | `400 Bad Request` |
| `image` | If provided: JPEG, PNG, or WebP only | `400 Bad Request` |
| `image` | If provided: max 5 MB | `400 Bad Request` |

Return a structured error body with a `code` and `message`. **No credits are deducted for validation failures.**

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "description must be at least 10 characters."
  }
}
```

### Step 3a: Image Pre-Processing (If image provided)

- **Action:** Pass the image to the vision model configured via `CAPTIONING_MODEL` (default: `gemini-1.5-flash`) to extract a concise, plain-text physical description and material estimate.
- **Timeout:** 15 seconds. On timeout or provider error, return `503 Service Unavailable` with `Retry-After: 10`. **Do not deduct credits.**
- **Cost Flag:** Mark the request internally as `image_included: true` to trigger the 2-credit deduction path.
- **Merge:** Append the extracted keywords to the user's provided `description` to form the unified query string for Step 3b.

### Step 3b: Retrieval

- **Action:** Embed the unified query string (user text + image caption, if any) using `text-embedding-004`.
- **Search:** Query the vector DB against the synthetically-expanded HS code corpus using cosine similarity. Retrieve the **top 5** matches with their similarity scores.
- **Candidate set:** All 5 results are carried forward to Step 3c; filtering happens after tier assignment.

### Step 3c: Confidence Math & Tier Assignment

Confidence is a composite of the **absolute top score** (is the best match relevant at all?) and the **margin** (is the top match clearly better than the runner-up?).

All four thresholds below are environment-variable-tunable and must not be hardcoded:

| Env Var | Default | Description |
|---|---|---|
| `CONFIDENCE_FLOOR` | `0.60` | Minimum top score to avoid LOW tier |
| `HIGH_CONFIDENCE_MARGIN` | `0.15` | Minimum margin for HIGH tier |
| `MAX_MEDIUM_CANDIDATES` | `3` | Max candidates returned in MEDIUM tier |
| `CANDIDATE_MIN_SCORE` | `0.60` | Minimum score for a result to appear as a candidate |

**Tier logic:**

```
if results.length === 0:
    tier = LOW_CONFIDENCE
elif results.length === 1:
    top = scores[0]
    margin = +Infinity
else:
    top = scores[0]
    margin = scores[0] - scores[1]

if results.length > 0:
    if top < CONFIDENCE_FLOOR:
        tier = LOW_CONFIDENCE
    elif margin >= HIGH_CONFIDENCE_MARGIN:
        tier = HIGH_CONFIDENCE
    else:
        tier = MEDIUM_CONFIDENCE
```

### Step 3d: Candidate Filtering (Between Retrieval and Rationale)

After tier assignment, apply this deterministic rule to select which HS codes are passed to the LLM in Step 3e:

| Tier | Candidates passed to LLM |
|---|---|
| `HIGH_CONFIDENCE` | Rank #1 only |
| `MEDIUM_CONFIDENCE` | All results with score >= `CANDIDATE_MIN_SCORE`, capped at `MAX_MEDIUM_CANDIDATES` (default: 3), ordered by descending similarity score |
| `LOW_CONFIDENCE` | None — skip Step 3e entirely |

Candidates are **ranked by vector similarity score, descending**. The LLM does not re-rank.

### Step 3e: Rationale Generation

*Skipped entirely for `LOW_CONFIDENCE` — return the refusal response immediately.*

- **Action:** Pass the user's original text (and image, if provided) alongside the filtered candidate HS codes to `CLASSIFICATION_MODEL` (default: `gemini-1.5-flash`).
- **Prompt Directive:** The LLM's sole job is to write a 1–2 sentence rationale for *why* the product fits each retrieved code based on the user's input. It does **not** rank, reorder, or select codes.
- **Timeout:** 15 seconds. On timeout or provider error, return `503 Service Unavailable` with `Retry-After: 10`. **Do not deduct credits.**
- **Credit deduction** occurs only after this step completes successfully (see Section 6 for deduction + rollback logic).

---

## 4. Output Shape & Tiers

### High Confidence

Returns a single HS-6 code, its rationale, and the similarity score.

```json
{
  "classification_id": "uuid-v4",
  "tier": "high",
  "review_recommended": false,
  "country_specific_codes": null,
  "candidates": [
    {
      "hs_code": "7323.93",
      "description": "Table, kitchen or other household articles, of stainless steel",
      "rationale": "The item is described as a double-walled insulated thermos, which falls under household stainless steel articles.",
      "confidence_score": 0.88
    }
  ]
}
```

### Medium Confidence

Returns 2–3 ranked candidates (ranked by similarity score, descending) with rationales, and `review_recommended: true`.

```json
{
  "classification_id": "uuid-v4",
  "tier": "medium",
  "review_recommended": true,
  "country_specific_codes": null,
  "candidates": [
    {
      "hs_code": "7323.93",
      "description": "Table, kitchen or other household articles, of stainless steel",
      "rationale": "...",
      "confidence_score": 0.74
    },
    {
      "hs_code": "9617.00",
      "description": "Vacuum flasks and other vacuum vessels",
      "rationale": "...",
      "confidence_score": 0.68
    }
  ]
}
```

### Low Confidence (Refusal)

Returns `422 Unprocessable Entity`. The request was valid; the *content* cannot be classified with sufficient confidence. No codes are returned.

```json
{
  "classification_id": "uuid-v4",
  "error": {
    "code": "INSUFFICIENT_DETAIL",
    "message": "Unable to classify with sufficient confidence. Please provide more material or functional details."
  }
}
```

> **HTTP Status Reference:**
> - `400 Bad Request` — validation failures (missing field, wrong type, size exceeded). The request is malformed.
> - `422 Unprocessable Entity` — low-confidence refusals. The request is valid; the content is the problem.
> - `402 Payment Required` — insufficient credit balance.
> - `503 Service Unavailable` — upstream LLM or embedding provider error.
