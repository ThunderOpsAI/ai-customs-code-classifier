CREATE TABLE hs_corpus (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hs_code TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    embedding vector(768),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON hs_corpus USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
