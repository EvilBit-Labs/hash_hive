ALTER TABLE "tasks" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "committed_keyspace_offset" bigint;--> statement-breakpoint
CREATE INDEX "tasks_expired_lease_idx" ON "tasks" USING btree ("lease_expires_at") WHERE status IN ('assigned', 'running');
