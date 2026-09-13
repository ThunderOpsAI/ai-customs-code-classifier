CREATE TABLE processed_stripe_events (
    stripe_event_id TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
