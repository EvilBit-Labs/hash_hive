ALTER TABLE "campaigns" ADD COLUMN "is_permanent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
-- Backfill (ADR-0019): mark every campaign that has ever left draft as permanent.
-- `status <> 'draft'` covers currently-active/terminal campaigns; `started_at IS NOT NULL`
-- also latches a started-then-edited campaign whose status was returned to 'draft', which
-- the status check alone would miss and would otherwise leave wrongly deletable.
UPDATE "campaigns" SET "is_permanent" = true WHERE "status" <> 'draft' OR "started_at" IS NOT NULL;
