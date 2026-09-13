# V2 Backlog

Features and expansions deferred from MVP — tracked here so they inform MVP design without bloating MVP scope.

---

## Country-specific tariff codes (8–10 digits)

**Context:** MVP returns HS-6 (international, jurisdiction-agnostic). Real customs filings require 8–10 digit codes that vary by country (US HTS, EU CN/TARIC, UK, AU, etc.).

**Why deferred:** Data sourcing complexity explodes (dozens of national schedules, origin+destination required), and it pushes the product toward "authoritative filing tool" territory — the opposite of MVP's "suggestion, not authority" positioning.

**What to build toward:**
- Start with US HTS and/or EU CN/TARIC as premium tier
- Requires: country of origin + destination as additional inputs
- Requires: ingestion pipeline for national tariff schedule updates (Section 301/232/IEEPA stacking for US, TARIC updates for EU)
- The accept/reject feedback loop from MVP sellers will be valuable training signal here

**MVP design implication:** The API response schema should leave room for a `country_specific_codes` field (even if null at MVP) so integrators don't need to rewrite their parsing later. The UI should clearly label output as "HS-6 (International)" so users aren't confused about what they're getting.

---

## Metered / postpaid billing for enterprise accounts

**Context:** MVP uses prepaid credits (buy balance via Stripe Checkout, each call decrements, reject at zero). Enterprise logistics platforms will expect postpaid metered billing — usage records, monthly invoices, net-30 terms.

**Why deferred:** Stripe metered billing API, dunning flows, and credit-risk management are a meaningfully bigger build. MVP needs to ship fast with zero credit risk.

**What to build toward:**
- Stripe metered billing (usage records → invoice at period end)
- Dunning and failed-payment handling
- Tiered pricing (volume discounts for high-usage accounts)
- Account-level spend limits and alerting

**MVP design implication:** The `usage_log` table built for prepaid tracking is the same data Stripe metered billing needs. Build it well now.

---

## Advanced feedback loop / active learning

**Context:** MVP captures which HS code candidate the seller selected via `classification_id` + chosen `hs_code`. V2 should close the loop by using this signal to improve retrieval quality.

**What to build toward:**
- Periodic retraining / re-embedding of the synthetic expansion corpus using accept/reject patterns
- Active learning: surface low-confidence classifications that were accepted for human expert review
- Analytics dashboard: rejection rates by HS chapter, most-confused code pairs, confidence calibration curves
