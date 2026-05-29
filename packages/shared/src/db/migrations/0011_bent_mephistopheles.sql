-- P-H3 performance indexes (comprehensive-review).
--
-- Online safety: these are plain CREATE INDEX (NOT CONCURRENTLY).
-- Drizzle's migrator runs each statement inside a transaction and
-- CONCURRENTLY cannot run in a tx, so the two are mutually exclusive
-- in this codebase's migration runner. For low-traffic / air-gapped
-- lab deployments (the project's primary target) the brief locks
-- the plain form takes are immaterial: tables are small, locks
-- last milliseconds.
--
-- For high-traffic deployments with millions of rows, do NOT
-- pre-create same-named indexes before running this migration --
-- plain CREATE INDEX fails with "relation already exists" rather
-- than silently no-op'ing. If you need zero-downtime index builds,
-- bypass this migration entirely for those indexes: apply the
-- CONCURRENTLY equivalents directly on the database, then mark
-- migration 0011 as applied in the Drizzle migrations table without
-- running it (so the schema_migrations row exists and 0012+ can
-- proceed normally). Coordinate this with whoever owns deploy.

-- Heartbeat-monitor sweep filters by lastSeenAt to detect stale agents.
CREATE INDEX "agents_last_seen_at_idx" ON "agents" USING btree ("last_seen_at");--> statement-breakpoint
-- assignNextTask + heartbeat hint filter by JSONB requiredCapabilities.
CREATE INDEX "tasks_required_capabilities_gpu_idx" ON "tasks" USING btree (((required_capabilities ->> 'gpu')));--> statement-breakpoint
CREATE INDEX "tasks_required_capabilities_hashcat_mode_idx" ON "tasks" USING btree (((required_capabilities ->> 'hashcatMode')));--> statement-breakpoint
-- Partial index for the assignNextTask hot path. Bounded to pending+
-- unassigned rows so it stays tiny as completed-task history grows.
CREATE INDEX "tasks_pending_unassigned_idx" ON "tasks" USING btree ("campaign_id","id") WHERE status = 'pending' AND agent_id IS NULL;
