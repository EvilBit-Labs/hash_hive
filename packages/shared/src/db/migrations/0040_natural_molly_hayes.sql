ALTER TABLE "campaigns" ADD COLUMN "parent_campaign_id" integer;--> statement-breakpoint
ALTER TABLE "hash_items" ADD COLUMN "detected_hashcat_mode" integer;--> statement-breakpoint
ALTER TABLE "hash_lists" ADD COLUMN "parent_hash_list_id" integer;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_parent_campaign_id_campaigns_id_fk" FOREIGN KEY ("parent_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_lists" ADD CONSTRAINT "hash_lists_parent_hash_list_id_hash_lists_id_fk" FOREIGN KEY ("parent_hash_list_id") REFERENCES "public"."hash_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_parent_campaign_id_idx" ON "campaigns" USING btree ("parent_campaign_id");--> statement-breakpoint
CREATE INDEX "hash_lists_parent_hash_list_id_idx" ON "hash_lists" USING btree ("parent_hash_list_id");--> statement-breakpoint
-- KTD7 (#202): a split sub-list must share its parent's project_id, so the
-- parent->children scope expansion (resolveHashListScope) can never cross
-- tenants. A CHECK constraint cannot contain a subquery, so this is enforced
-- with a BEFORE INSERT/UPDATE trigger. Hand-written (drizzle-kit does not
-- emit triggers); mirrors the repo pattern of hand-authored DDL in migrations.
CREATE OR REPLACE FUNCTION hash_lists_parent_project_check() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_hash_list_id IS NOT NULL THEN
    IF (SELECT project_id FROM hash_lists WHERE id = NEW.parent_hash_list_id)
       IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'sub-list project_id (%) must match its parent hash list project_id', NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE TRIGGER hash_lists_parent_project_check_trg
  BEFORE INSERT OR UPDATE OF parent_hash_list_id, project_id ON hash_lists
  FOR EACH ROW EXECUTE FUNCTION hash_lists_parent_project_check();
