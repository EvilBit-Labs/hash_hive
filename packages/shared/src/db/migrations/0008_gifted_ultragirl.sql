-- Safe on populated tables: Postgres >= 11 stores the constant default as
-- table metadata and does not rewrite existing rows.
ALTER TABLE "tasks" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Backfill the new column from the legacy result_stats.retryCount field so
-- in-flight tasks that already exhausted part of their retry budget do not
-- silently reset to 0 at cutover. Idempotent: re-running picks the same
-- COALESCE result. Cast goes through text first so non-integer JSONB values
-- (which should not exist but are technically possible) become NULL and
-- fall through to the existing retry_count value via COALESCE.
UPDATE "tasks"
SET "retry_count" = COALESCE(NULLIF(("result_stats" ->> 'retryCount'), '')::int, "retry_count")
WHERE "result_stats" ? 'retryCount';
