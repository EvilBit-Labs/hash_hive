-- Corrects the hashcat_mode expression index introduced in migration
-- 0011. The original was indexed on the TEXT value of
-- `required_capabilities ->> 'hashcatMode'`, but the actual query in
-- services/tasks.ts buildCapabilityPredicate casts to int:
--   (required_capabilities ->> 'hashcatMode')::int = ANY($1::int[])
-- Postgres expression indexes are only usable when the indexed
-- expression matches the query expression exactly, so the text index
-- never served the hot path. Drop + recreate on the casted form.
DROP INDEX "tasks_required_capabilities_hashcat_mode_idx";--> statement-breakpoint
CREATE INDEX "tasks_required_capabilities_hashcat_mode_idx" ON "tasks" USING btree ((((required_capabilities ->> 'hashcatMode'))::int));
