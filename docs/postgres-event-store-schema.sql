CREATE TABLE IF NOT EXISTS event_store (
  global_position BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  actor JSONB NOT NULL,
  payload JSONB NOT NULL,
  command_id TEXT NULL,
  correlation_id TEXT NULL,
  causation_id TEXT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  CONSTRAINT uq_event_stream_version UNIQUE (aggregate_type, aggregate_id, aggregate_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_store_command_id
  ON event_store (command_id)
  WHERE command_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_event_store_stream
  ON event_store (aggregate_type, aggregate_id, global_position);

CREATE INDEX IF NOT EXISTS ix_event_store_correlation
  ON event_store (correlation_id, global_position);

CREATE TABLE IF NOT EXISTS projection_checkpoints (
  projection_name TEXT PRIMARY KEY,
  last_global_position BIGINT NOT NULL,
  snapshot JSONB NOT NULL,
  integrity JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
