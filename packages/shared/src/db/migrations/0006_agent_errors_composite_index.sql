DROP INDEX IF EXISTS "agent_errors_agent_id_idx";--> statement-breakpoint
CREATE INDEX "agent_errors_agent_id_created_at_idx" ON "agent_errors" USING btree ("agent_id","created_at" DESC);
