CREATE TABLE "agent_errors" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"severity" varchar(20) DEFAULT 'error' NOT NULL,
	"message" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb,
	"task_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"project_id" integer NOT NULL,
	"operating_system_id" integer,
	"auth_token" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'offline' NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb,
	"hardware_profile" jsonb DEFAULT '{}'::jsonb,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_auth_token_unique" UNIQUE("auth_token")
);
--> statement-breakpoint
CREATE TABLE "attacks" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"mode" integer NOT NULL,
	"hash_type_id" integer,
	"wordlist_id" integer,
	"rulelist_id" integer,
	"masklist_id" integer,
	"advanced_configuration" jsonb DEFAULT '{}'::jsonb,
	"keyspace" varchar(255),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"dependencies" integer[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"hash_list_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_by" integer,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hash_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"hash_list_id" integer NOT NULL,
	"hash_value" varchar(1024) NOT NULL,
	"plaintext" text,
	"cracked_at" timestamp with time zone,
	"campaign_id" integer,
	"attack_id" integer,
	"task_id" integer,
	"agent_id" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hash_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"hash_type_id" integer,
	"source" varchar(50) DEFAULT 'upload' NOT NULL,
	"file_ref" jsonb DEFAULT '{}'::jsonb,
	"statistics" jsonb DEFAULT '{}'::jsonb,
	"status" varchar(20) DEFAULT 'uploading' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hash_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"hashcat_mode" integer NOT NULL,
	"category" varchar(100),
	"example" text,
	CONSTRAINT "hash_types_hashcat_mode_unique" UNIQUE("hashcat_mode")
);
--> statement-breakpoint
CREATE TABLE "mask_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"file_ref" jsonb DEFAULT '{}'::jsonb,
	"line_count" integer,
	"file_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operating_systems" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"version" varchar(100),
	"platform" varchar(100)
);
--> statement-breakpoint
CREATE TABLE "project_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"roles" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"slug" varchar(255) NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "rule_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"file_ref" jsonb DEFAULT '{}'::jsonb,
	"line_count" integer,
	"file_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"attack_id" integer NOT NULL,
	"campaign_id" integer NOT NULL,
	"agent_id" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"work_range" jsonb DEFAULT '{}'::jsonb,
	"progress" jsonb DEFAULT '{}'::jsonb,
	"result_stats" jsonb DEFAULT '{}'::jsonb,
	"required_capabilities" jsonb DEFAULT '{}'::jsonb,
	"assigned_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "word_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"file_ref" jsonb DEFAULT '{}'::jsonb,
	"line_count" integer,
	"file_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_errors" ADD CONSTRAINT "agent_errors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_operating_system_id_operating_systems_id_fk" FOREIGN KEY ("operating_system_id") REFERENCES "public"."operating_systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_hash_type_id_hash_types_id_fk" FOREIGN KEY ("hash_type_id") REFERENCES "public"."hash_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_wordlist_id_word_lists_id_fk" FOREIGN KEY ("wordlist_id") REFERENCES "public"."word_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_rulelist_id_rule_lists_id_fk" FOREIGN KEY ("rulelist_id") REFERENCES "public"."rule_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_masklist_id_mask_lists_id_fk" FOREIGN KEY ("masklist_id") REFERENCES "public"."mask_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_hash_list_id_hash_lists_id_fk" FOREIGN KEY ("hash_list_id") REFERENCES "public"."hash_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_items" ADD CONSTRAINT "hash_items_hash_list_id_hash_lists_id_fk" FOREIGN KEY ("hash_list_id") REFERENCES "public"."hash_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_items" ADD CONSTRAINT "hash_items_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_items" ADD CONSTRAINT "hash_items_attack_id_attacks_id_fk" FOREIGN KEY ("attack_id") REFERENCES "public"."attacks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_items" ADD CONSTRAINT "hash_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_items" ADD CONSTRAINT "hash_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_lists" ADD CONSTRAINT "hash_lists_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_lists" ADD CONSTRAINT "hash_lists_hash_type_id_hash_types_id_fk" FOREIGN KEY ("hash_type_id") REFERENCES "public"."hash_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mask_lists" ADD CONSTRAINT "mask_lists_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_users" ADD CONSTRAINT "project_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_users" ADD CONSTRAINT "project_users_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_lists" ADD CONSTRAINT "rule_lists_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_attack_id_attacks_id_fk" FOREIGN KEY ("attack_id") REFERENCES "public"."attacks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_lists" ADD CONSTRAINT "word_lists_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_errors_agent_id_idx" ON "agent_errors" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agents_project_id_idx" ON "agents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "agents_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "attacks_campaign_id_idx" ON "attacks" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaigns_project_id_status_idx" ON "campaigns" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "hash_items_hash_list_id_hash_value_idx" ON "hash_items" USING btree ("hash_list_id","hash_value");--> statement-breakpoint
CREATE INDEX "hash_items_hash_list_id_idx" ON "hash_items" USING btree ("hash_list_id");--> statement-breakpoint
CREATE INDEX "hash_items_cracked_at_idx" ON "hash_items" USING btree ("cracked_at");--> statement-breakpoint
CREATE INDEX "hash_items_campaign_id_idx" ON "hash_items" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "hash_lists_project_id_idx" ON "hash_lists" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "hash_lists_status_idx" ON "hash_lists" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "project_users_user_project_idx" ON "project_users" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE INDEX "tasks_campaign_id_idx" ON "tasks" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "tasks_agent_id_idx" ON "tasks" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_status_campaign_id_idx" ON "tasks" USING btree ("status","campaign_id");
