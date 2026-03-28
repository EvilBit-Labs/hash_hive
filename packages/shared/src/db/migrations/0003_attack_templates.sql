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
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_hash_type_id_hash_types_id_fk" FOREIGN KEY ("hash_type_id") REFERENCES "public"."hash_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_wordlist_id_word_lists_id_fk" FOREIGN KEY ("wordlist_id") REFERENCES "public"."word_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_rulelist_id_rule_lists_id_fk" FOREIGN KEY ("rulelist_id") REFERENCES "public"."rule_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_masklist_id_mask_lists_id_fk" FOREIGN KEY ("masklist_id") REFERENCES "public"."mask_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attack_templates_project_name_idx" ON "attack_templates" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "attack_templates_project_id_idx" ON "attack_templates" USING btree ("project_id");
