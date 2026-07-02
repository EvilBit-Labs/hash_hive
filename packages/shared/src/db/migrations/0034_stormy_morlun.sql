ALTER TABLE "attacks" ADD COLUMN "is_permanent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attacks" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
-- Backfill (ADR-0019 / #106): an attack is "used" (permanent) once it has
-- generated any task. Latch those so they can no longer be hard-deleted.
UPDATE "attacks" SET "is_permanent" = true WHERE "id" IN (SELECT DISTINCT "attack_id" FROM "tasks");--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_archive_consistency_chk" CHECK ("attacks"."archived_at" IS NULL OR "attacks"."is_permanent" = true);
