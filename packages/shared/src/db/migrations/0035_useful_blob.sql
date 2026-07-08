ALTER TABLE "campaigns" ADD COLUMN "hashcat_mode" integer;--> statement-breakpoint
-- Backfill (issue #100): latch each campaign's hashcat_mode to its
-- earliest attack's mode. Campaigns with no attacks stay NULL.
UPDATE "campaigns" c SET "hashcat_mode" = (
  SELECT a."mode" FROM "attacks" a WHERE a."campaign_id" = c."id" ORDER BY a."id" LIMIT 1
);--> statement-breakpoint
-- Safety gate: abort the migration (and roll back the backfill above) if any
-- existing campaign already mixes hashcat modes across its attacks. The
-- single-hash-mode-per-campaign FK added below can only be satisfied if the
-- backfilled hashcat_mode matches every attack's mode; a legacy mixed-mode
-- campaign would otherwise become permanently uninsertable/unupdatable for
-- its non-conforming attacks with no clear error. Surface it here instead so
-- a human resolves the data before this migration is allowed to apply.
DO $$
DECLARE
  mismatched_count integer;
BEGIN
  SELECT COUNT(*) INTO mismatched_count
  FROM "attacks" a
  JOIN "campaigns" c ON c."id" = a."campaign_id"
  WHERE c."hashcat_mode" IS NOT NULL AND a."mode" <> c."hashcat_mode";

  IF mismatched_count > 0 THEN
    RAISE EXCEPTION 'single-hash-mode-per-campaign migration blocked: % attack row(s) have a mode that differs from their campaign''s backfilled hashcat_mode. Resolve these mixed-mode campaigns manually before re-running this migration.', mismatched_count;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_id_hashcat_mode_idx" ON "campaigns" USING btree ("id","hashcat_mode");--> statement-breakpoint
-- DEFERRABLE INITIALLY DEFERRED (not expressible via drizzle-orm's
-- `foreignKey()` builder in schema.ts as of this drizzle-orm version --
-- hand-added here, schema.ts documents the drift): `updateAttack`
-- (services/campaigns.ts) adaptively moves a campaign onto an edited
-- attack's new mode by running two separate statements in one
-- transaction -- UPDATE campaigns.hashcat_mode, then UPDATE the attack's
-- mode. A NOT DEFERRABLE (default) FK is checked immediately after EACH
-- statement, so the moment between them (parent updated, child not yet)
-- would spuriously violate the FK even when the two statements agree by
-- the time the transaction commits. Deferring the check to COMMIT lets
-- that update land atomically while still rejecting a genuine conflict at
-- commit time with the same SQLSTATE 23503 / constraint_name.
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_campaign_id_mode_campaigns_id_hashcat_mode_fk" FOREIGN KEY ("campaign_id","mode") REFERENCES "public"."campaigns"("id","hashcat_mode") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
