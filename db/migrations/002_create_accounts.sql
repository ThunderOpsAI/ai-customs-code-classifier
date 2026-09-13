CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
