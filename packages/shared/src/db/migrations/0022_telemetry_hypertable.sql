-- U8: Convert task_telemetry to a TimescaleDB hypertable with continuous
-- aggregates (1m / 5m / 1h rollup tiers) and RRD-style retention policies.
--
-- Design: full-res raw ~1h -> 1m rollup ~24h -> 5m rollup ~7d -> 1h rollup ~30d.
-- Retention drops oldest chunks when a tier's window is exceeded, so total
-- telemetry footprint stays bounded regardless of insert volume (ADR-0015).
--
-- FOOTGUN WARNING (pin this): every CAGG refresh policy's end_offset MUST be
-- shorter than the raw hypertable's retention drop_after. The hypertable uses
-- chunk_time_interval = 1 hour; retention drops a chunk only once its FULL
-- range is past drop_after, so raw data survives ~1-2h in practice. The 1m
-- CAGG's end_offset of 1 minute is well within that window — the aggregate
-- materializes before raw chunks are eligible for eviction. If end_offset
-- ever exceeds drop_after, raw chunks can be dropped before the CAGG has
-- materialized that window, silently losing rollup data.
--
-- Retention footgun invariant satisfied:
--   raw drop_after     = 1 hour     (chunk survives ~1-2h due to chunk granularity)
--   1m  end_offset     = 1 minute   ✓ << raw drop_after
--   5m  end_offset     = 5 minutes  ✓ << raw drop_after
--   1h  end_offset     = 1 minute   ✓ << raw drop_after
--
-- Transaction note: all TimescaleDB DDL below (create_hypertable, CREATE
-- MATERIALIZED VIEW ... WITH timescaledb.continuous, add_*_policy) runs
-- without error inside a transaction block on TimescaleDB 2.17.2. Drizzle's
-- postgres-js migrator wraps migration statements in a transaction; this was
-- verified against the live DB before shipping this migration.

-- Step 1: Enable TimescaleDB extension (idempotent; already present on the
-- production image via /docker-entrypoint-initdb.d/init-timescaledb.sql, but
-- must be explicit here for fresh test databases created by setup-test-db.ts).
CREATE EXTENSION IF NOT EXISTS timescaledb;

--> statement-breakpoint

-- Step 2: Convert task_telemetry to a hypertable.
-- Uses the modern by_range() dimension form (available in TimescaleDB 2.17.2).
-- chunk_time_interval = 1 hour matches the full-res retention window so each
-- retention drop removes exactly one hour of raw data.
-- migrate_data => true preserves any rows already present (safe on empty table;
-- noted for ops: on a large non-empty table this locks the table briefly while
-- chunks are created — not a concern before Phase 4 ships to prod).
-- if_not_exists => true makes re-runs of this migration idempotent (e.g. if
-- the test DB had a partial state from a prior interrupted run).
SELECT create_hypertable(
  'task_telemetry',
  by_range('time', INTERVAL '1 hour'),
  migrate_data => true,
  if_not_exists => true
);

--> statement-breakpoint

-- Step 3a: 1-minute continuous aggregate.
-- Columns exposed for U9 dashboard reads:
--   max_keyspace_progress  — monotone watermark for current task progress
--   avg_speed_hs / max_speed_hs — speed summary for dashboard rate display
--   avg_temperature        — optional monitoring
-- agent_id is intentionally excluded from GROUP BY: U9 reads progress per task,
-- not per (task, agent) pair; grouping by agent would fragment the watermark
-- and require a GREATEST() reduction at query time, adding complexity for no gain.
CREATE MATERIALIZED VIEW task_telemetry_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', "time") AS bucket,
  task_id,
  avg(speed_hs)::bigint        AS avg_speed_hs,
  max(speed_hs)                AS max_speed_hs,
  max(keyspace_progress)       AS max_keyspace_progress,
  avg(temperature)             AS avg_temperature
FROM task_telemetry
GROUP BY bucket, task_id
WITH NO DATA;

--> statement-breakpoint

-- Step 3b: 5-minute continuous aggregate (built on raw, not on 1m).
-- Timescale recommends building CAGGs on the raw hypertable rather than chaining
-- CAGG-on-CAGG to avoid materialization ordering constraints in 2.17.x.
CREATE MATERIALIZED VIEW task_telemetry_5m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('5 minutes', "time") AS bucket,
  task_id,
  avg(speed_hs)::bigint        AS avg_speed_hs,
  max(speed_hs)                AS max_speed_hs,
  max(keyspace_progress)       AS max_keyspace_progress,
  avg(temperature)             AS avg_temperature
FROM task_telemetry
GROUP BY bucket, task_id
WITH NO DATA;

--> statement-breakpoint

-- Step 3c: 1-hour continuous aggregate (built on raw).
CREATE MATERIALIZED VIEW task_telemetry_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', "time") AS bucket,
  task_id,
  avg(speed_hs)::bigint        AS avg_speed_hs,
  max(speed_hs)                AS max_speed_hs,
  max(keyspace_progress)       AS max_keyspace_progress,
  avg(temperature)             AS avg_temperature
FROM task_telemetry
GROUP BY bucket, task_id
WITH NO DATA;

--> statement-breakpoint

-- Step 4a: CAGG refresh policy for 1m rollup.
-- start_offset = 30 minutes: refresh the last 30 minutes of data on each run,
-- catching any late-arriving rows within a reasonable window.
-- end_offset = 1 minute: leave the most recent 1 minute unmaterialized so
-- in-progress inserts from the current partial bucket are not partially captured.
-- FOOTGUN GUARD: end_offset (1m) < raw retention drop_after (1h) ✓
SELECT add_continuous_aggregate_policy(
  'task_telemetry_1m',
  start_offset    => INTERVAL '30 minutes',
  end_offset      => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists   => true
);

--> statement-breakpoint

-- Step 4b: CAGG refresh policy for 5m rollup.
-- end_offset = 5 minutes: leave the current partial 5-minute bucket open.
-- FOOTGUN GUARD: end_offset (5m) < raw retention drop_after (1h) ✓
SELECT add_continuous_aggregate_policy(
  'task_telemetry_5m',
  start_offset    => INTERVAL '1 hour',
  end_offset      => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists   => true
);

--> statement-breakpoint

-- Step 4c: CAGG refresh policy for 1h rollup.
-- end_offset = 1 minute: keep a short lag so the raw-tier retention (1h)
-- does not drop chunks before the 1h CAGG has materialized them.
-- FOOTGUN GUARD: end_offset (1m) < raw retention drop_after (1h) ✓
SELECT add_continuous_aggregate_policy(
  'task_telemetry_1h',
  start_offset    => INTERVAL '3 hours',
  end_offset      => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists   => true
);

--> statement-breakpoint

-- Step 5: Retention policy on the raw hypertable.
-- Default: keep 1 hour of full-resolution data.
-- KTD-7: applyTelemetryRetentionPolicies() at API startup re-applies this from
-- the TELEMETRY_FULLRES_RETENTION env var, allowing operators to override without
-- a migration. The migration default is the canonical fallback.
SELECT add_retention_policy(
  'task_telemetry',
  drop_after    => INTERVAL '1 hour',
  if_not_exists => true
);

--> statement-breakpoint

-- Step 6a: Retention policy on the 1m CAGG.
-- Default: keep 24 hours of 1-minute rollups.
SELECT add_retention_policy(
  'task_telemetry_1m',
  drop_after    => INTERVAL '24 hours',
  if_not_exists => true
);

--> statement-breakpoint

-- Step 6b: Retention policy on the 5m CAGG.
-- Default: keep 7 days of 5-minute rollups.
SELECT add_retention_policy(
  'task_telemetry_5m',
  drop_after    => INTERVAL '7 days',
  if_not_exists => true
);

--> statement-breakpoint

-- Step 6c: Retention policy on the 1h CAGG.
-- Default: keep 30 days of 1-hour rollups.
SELECT add_retention_policy(
  'task_telemetry_1h',
  drop_after    => INTERVAL '30 days',
  if_not_exists => true
);
