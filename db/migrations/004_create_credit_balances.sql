CREATE TABLE credit_balances (
    account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
