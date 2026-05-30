ALTER TABLE "users" ADD COLUMN "roles" text[] DEFAULT '{"analyst"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_project_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_last_project_id_projects_id_fk" FOREIGN KEY ("last_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill existing user rows to the 'admin' tier so the migration is
-- non-disruptive (current de-facto behavior is that any user can manage
-- projects). The 'analyst' column default applies to NEW rows only; the
-- application layer always passes roles explicitly on insert so a new
-- account is never silently created as admin via the default. Operators
-- tighten roles via the admin tool or seed update post-deploy.
UPDATE "users" SET "roles" = ARRAY['admin'] WHERE "roles" = ARRAY['analyst'];
