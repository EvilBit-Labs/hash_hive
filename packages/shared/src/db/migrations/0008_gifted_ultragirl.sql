-- Safe on populated tables: Postgres >= 11 stores the constant default as
-- table metadata and does not rewrite existing rows.
ALTER TABLE "tasks" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Backfill the new column from the legacy result_stats.retryCount field so
-- in-flight tasks that already exhausted part of their retry budget do not
-- silently reset to 0 at cutover. Idempotent: re-running picks the same
-- result. Guard the ::int cast with a non-negative-integer regex so a
-- single malformed JSONB row (e.g. 'abc', '3.5', '-1') cannot abort the
-- migration; non-matching values fall through to the existing retry_count
-- via COALESCE.
UPDATE "tasks"
SET "retry_count" = COALESCE(
  CASE
    WHEN ("result_stats" ->> 'retryCount') ~ '^[0-9]+$'
      THEN ("result_stats" ->> 'retryCount')::int
    ELSE NULL
  END,
  "retry_count"
)
WHERE "result_stats" ? 'retryCount';
