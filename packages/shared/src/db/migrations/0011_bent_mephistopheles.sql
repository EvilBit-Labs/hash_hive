-- P-H3 performance indexes (comprehensive-review).
--
-- Online safety: these are CREATE INDEX (NOT CONCURRENTLY) because
-- Drizzle's migrator runs each statement inside a transaction and
-- CONCURRENTLY cannot run in a tx. For low-traffic / air-gapped lab
-- deployments (the project's primary target) this is fine: the tables
-- are small and the locks are brief.
--
-- For high-traffic deployments with millions of rows, operators should
-- apply these manually with CONCURRENTLY before running `just db-migrate`:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS agents_last_seen_at_idx
--     ON agents USING btree (last_seen_at);
--   ... (one CONCURRENTLY for each)
-- Drizzle's migrator will then no-op the matching CREATE INDEX below
-- (Postgres errors loudly if the index already exists, so use
-- IF NOT EXISTS hand-applies and accept the schema_migrations row
-- created when the Drizzle CREATE no-ops).

-- Heartbeat-monitor sweep filters by lastSeenAt to detect stale agents.
CREATE INDEX "agents_last_seen_at_idx" ON "agents" USING btree ("last_seen_at");--> statement-breakpoint
-- assignNextTask + heartbeat hint filter by JSONB requiredCapabilities.
CREATE INDEX "tasks_required_capabilities_gpu_idx" ON "tasks" USING btree (((required_capabilities ->> 'gpu')));--> statement-breakpoint
CREATE INDEX "tasks_required_capabilities_hashcat_mode_idx" ON "tasks" USING btree (((required_capabilities ->> 'hashcatMode')));--> statement-breakpoint
-- Partial index for the assignNextTask hot path. Bounded to pending+
-- unassigned rows so it stays tiny as completed-task history grows.
CREATE INDEX "tasks_pending_unassigned_idx" ON "tasks" USING btree ("campaign_id","id") WHERE status = 'pending' AND agent_id IS NULL;
