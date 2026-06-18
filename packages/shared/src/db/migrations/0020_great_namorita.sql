CREATE TABLE "enrollment_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"label" varchar(255),
	"secret_hash" varchar(255) NOT NULL,
	"is_reusable" boolean DEFAULT false NOT NULL,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" integer,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_tokens_use_count_chk" CHECK ("enrollment_tokens"."use_count" >= 0),
	CONSTRAINT "enrollment_tokens_max_uses_chk" CHECK ("enrollment_tokens"."max_uses" IS NULL OR "enrollment_tokens"."max_uses" > 0)
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "enrollment_client_id" varchar(255);--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrollment_tokens_project_id_idx" ON "enrollment_tokens" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_project_enrollment_client_unique" ON "agents" USING btree ("project_id","enrollment_client_id") WHERE "agents"."enrollment_client_id" IS NOT NULL;
