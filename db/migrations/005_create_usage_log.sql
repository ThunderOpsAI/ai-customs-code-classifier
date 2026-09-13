CREATE TABLE usage_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id),
    classification_id UUID NOT NULL UNIQUE,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    credits_deducted INTEGER NOT NULL,
    status TEXT NOT NULL,
    tier TEXT,
    image_included BOOLEAN NOT NULL DEFAULT false,
    description_hash TEXT,
    latency_ms INTEGER
);
