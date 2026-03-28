CREATE TABLE "attack_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"mode" integer NOT NULL,
	"hash_type_id" integer,
	"wordlist_id" integer,
	"rulelist_id" integer,
	"masklist_id" integer,
	"advanced_configuration" jsonb DEFAULT '{}'::jsonb,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ba_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ba_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ba_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "ba_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mask_lists" ALTER COLUMN "line_count" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "mask_lists" ALTER COLUMN "file_size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "rule_lists" ALTER COLUMN "line_count" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "rule_lists" ALTER COLUMN "file_size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "word_lists" ALTER COLUMN "line_count" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "word_lists" ALTER COLUMN "file_size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "mask_lists" ADD COLUMN "status" varchar(20) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "rule_lists" ADD COLUMN "status" varchar(20) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "word_lists" ADD COLUMN "status" varchar(20) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_hash_type_id_hash_types_id_fk" FOREIGN KEY ("hash_type_id") REFERENCES "public"."hash_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_wordlist_id_word_lists_id_fk" FOREIGN KEY ("wordlist_id") REFERENCES "public"."word_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_rulelist_id_rule_lists_id_fk" FOREIGN KEY ("rulelist_id") REFERENCES "public"."rule_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_masklist_id_mask_lists_id_fk" FOREIGN KEY ("masklist_id") REFERENCES "public"."mask_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ba_accounts" ADD CONSTRAINT "ba_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ba_sessions" ADD CONSTRAINT "ba_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attack_templates_project_name_idx" ON "attack_templates" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "attack_templates_project_id_idx" ON "attack_templates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ba_accounts_user_id_idx" ON "ba_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ba_accounts_user_id_provider_id_idx" ON "ba_accounts" USING btree ("user_id","provider_id");--> statement-breakpoint
CREATE INDEX "ba_sessions_user_id_idx" ON "ba_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ba_verifications_identifier_idx" ON "ba_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "agents_auth_token_idx" ON "agents" USING btree ("auth_token");--> statement-breakpoint
CREATE INDEX "hash_items_hash_list_cracked_idx" ON "hash_items" USING btree ("hash_list_id","cracked_at");--> statement-breakpoint
CREATE INDEX "tasks_campaign_id_status_idx" ON "tasks" USING btree ("campaign_id","status");
