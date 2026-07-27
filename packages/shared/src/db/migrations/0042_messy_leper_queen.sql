CREATE TABLE "super_hash_list_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"super_hash_list_id" integer NOT NULL,
	"member_hash_list_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "super_hash_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "hash_list_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "super_hash_list_id" integer;--> statement-breakpoint
ALTER TABLE "super_hash_list_members" ADD CONSTRAINT "super_hash_list_members_super_hash_list_id_super_hash_lists_id_fk" FOREIGN KEY ("super_hash_list_id") REFERENCES "public"."super_hash_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "super_hash_list_members" ADD CONSTRAINT "super_hash_list_members_member_hash_list_id_hash_lists_id_fk" FOREIGN KEY ("member_hash_list_id") REFERENCES "public"."hash_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "super_hash_lists" ADD CONSTRAINT "super_hash_lists_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "super_hash_list_members_super_hash_list_id_idx" ON "super_hash_list_members" USING btree ("super_hash_list_id");--> statement-breakpoint
CREATE UNIQUE INDEX "super_hash_list_members_member_hash_list_id_idx" ON "super_hash_list_members" USING btree ("member_hash_list_id");--> statement-breakpoint
CREATE INDEX "super_hash_lists_project_id_idx" ON "super_hash_lists" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_super_hash_list_id_super_hash_lists_id_fk" FOREIGN KEY ("super_hash_list_id") REFERENCES "public"."super_hash_lists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_super_hash_list_id_idx" ON "campaigns" USING btree ("super_hash_list_id");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_exactly_one_target_chk" CHECK (num_nonnulls("campaigns"."hash_list_id", "campaigns"."super_hash_list_id") = 1);--> statement-breakpoint
-- R5 (#101): a SuperHashlist member must live in the same project as its
-- super, so resolving a super to its member/leaf lists can never cross
-- tenants. A CHECK constraint cannot contain a subquery, so this is enforced
-- with a BEFORE INSERT/UPDATE trigger. Hand-written (drizzle-kit does not
-- emit triggers); mirrors `hash_lists_parent_project_check` from migration
-- 0040.
CREATE OR REPLACE FUNCTION super_member_project_check() RETURNS trigger AS $$
BEGIN
  IF (SELECT project_id FROM hash_lists WHERE id = NEW.member_hash_list_id)
     IS DISTINCT FROM
     (SELECT project_id FROM super_hash_lists WHERE id = NEW.super_hash_list_id) THEN
    RAISE EXCEPTION 'super hash list member (hash_list %) must share its super hash list (%) project_id', NEW.member_hash_list_id, NEW.super_hash_list_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- `CREATE OR REPLACE TRIGGER` is valid on PG14+ (this repo runs pg16), but
-- the conventional idempotent DROP+CREATE form is more portable across
-- Postgres versions and tooling that parses migration SQL statically.
DROP TRIGGER IF EXISTS super_member_project_check_trg ON super_hash_list_members;--> statement-breakpoint
CREATE TRIGGER super_member_project_check_trg
  BEFORE INSERT OR UPDATE OF super_hash_list_id, member_hash_list_id ON super_hash_list_members
  FOR EACH ROW EXECUTE FUNCTION super_member_project_check();