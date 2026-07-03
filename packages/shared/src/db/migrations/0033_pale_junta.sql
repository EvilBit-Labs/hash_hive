ALTER TABLE "hash_lists" ADD COLUMN "is_permanent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hash_lists" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mask_lists" ADD COLUMN "is_permanent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mask_lists" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mask_lists" ADD COLUMN "blob_reclaimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mask_lists" ADD COLUMN "file_checksum" varchar(255);--> statement-breakpoint
ALTER TABLE "rule_lists" ADD COLUMN "is_permanent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rule_lists" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rule_lists" ADD COLUMN "blob_reclaimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rule_lists" ADD COLUMN "file_checksum" varchar(255);--> statement-breakpoint
ALTER TABLE "word_lists" ADD COLUMN "is_permanent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "word_lists" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "word_lists" ADD COLUMN "blob_reclaimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "word_lists" ADD COLUMN "file_checksum" varchar(255);--> statement-breakpoint
-- Backfill (ADR-0019 / #106): latch permanence on resources that have already
-- been used, so they cannot be hard-deleted after this migration. A hash list is
-- "used" once a campaign references it; a word/rule/mask list once an attack does.
UPDATE "hash_lists" SET "is_permanent" = true WHERE "id" IN (SELECT DISTINCT "hash_list_id" FROM "campaigns");--> statement-breakpoint
UPDATE "word_lists" SET "is_permanent" = true WHERE "id" IN (SELECT DISTINCT "wordlist_id" FROM "attacks" WHERE "wordlist_id" IS NOT NULL);--> statement-breakpoint
UPDATE "rule_lists" SET "is_permanent" = true WHERE "id" IN (SELECT DISTINCT "rulelist_id" FROM "attacks" WHERE "rulelist_id" IS NOT NULL);--> statement-breakpoint
UPDATE "mask_lists" SET "is_permanent" = true WHERE "id" IN (SELECT DISTINCT "masklist_id" FROM "attacks" WHERE "masklist_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "hash_lists" ADD CONSTRAINT "hash_lists_archive_consistency_chk" CHECK ("hash_lists"."archived_at" IS NULL OR ("hash_lists"."is_permanent" = true AND "hash_lists"."status" = 'ready'));--> statement-breakpoint
ALTER TABLE "mask_lists" ADD CONSTRAINT "mask_lists_archive_consistency_chk" CHECK ("mask_lists"."archived_at" IS NULL OR ("mask_lists"."is_permanent" = true AND "mask_lists"."status" = 'ready'));--> statement-breakpoint
ALTER TABLE "rule_lists" ADD CONSTRAINT "rule_lists_archive_consistency_chk" CHECK ("rule_lists"."archived_at" IS NULL OR ("rule_lists"."is_permanent" = true AND "rule_lists"."status" = 'ready'));--> statement-breakpoint
ALTER TABLE "word_lists" ADD CONSTRAINT "word_lists_archive_consistency_chk" CHECK ("word_lists"."archived_at" IS NULL OR ("word_lists"."is_permanent" = true AND "word_lists"."status" = 'ready'));
