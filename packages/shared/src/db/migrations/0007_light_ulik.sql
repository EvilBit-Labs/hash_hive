-- Clear any orphan task references before attaching the FK. Pre-existing
-- agent_errors rows may reference task ids that have since been deleted;
-- ON DELETE SET NULL only applies to deletes that happen AFTER the FK is
-- in place, so we have to backfill old orphans manually.
UPDATE "agent_errors"
SET "task_id" = NULL
WHERE "task_id" IS NOT NULL
  AND "task_id" NOT IN (SELECT "id" FROM "tasks");--> statement-breakpoint
-- IF EXISTS guards against environments that were hand-rebuilt or had a
-- prior migration skipped — without it, a missing index blocks the FK
-- addition below. The index recreate normalizes the DESC NULLS clause
-- (pg's implicit NULLS FIRST → explicit NULLS LAST) so the snapshot and
-- the live DB agree; the brief gap between DROP and CREATE is acceptable
-- because the migration runs in one drizzle invocation.
DROP INDEX IF EXISTS "agent_errors_agent_id_created_at_idx";--> statement-breakpoint
ALTER TABLE "agent_errors" ADD CONSTRAINT "agent_errors_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_errors_agent_id_created_at_idx" ON "agent_errors" USING btree ("agent_id","created_at" DESC NULLS LAST);
