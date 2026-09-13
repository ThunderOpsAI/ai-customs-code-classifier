CREATE TABLE feedback_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    classification_id UUID NOT NULL REFERENCES usage_log(classification_id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    selected_hs_code TEXT,
    none_correct BOOLEAN NOT NULL DEFAULT false,
    correction TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
