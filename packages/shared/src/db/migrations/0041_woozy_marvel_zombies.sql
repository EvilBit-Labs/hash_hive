CREATE TABLE "project_cracked_hashes" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"hashcat_mode" integer NOT NULL,
	"hash_value" varchar(1024) NOT NULL,
	"plaintext" text,
	"cracked_at" timestamp with time zone NOT NULL,
	"original_cracked_at" timestamp with time zone,
	"source_hash_list_id" integer,
	"task_id" integer,
	"agent_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_cracked_hashes" ADD CONSTRAINT "project_cracked_hashes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cracked_hashes" ADD CONSTRAINT "project_cracked_hashes_source_hash_list_id_hash_lists_id_fk" FOREIGN KEY ("source_hash_list_id") REFERENCES "public"."hash_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cracked_hashes" ADD CONSTRAINT "project_cracked_hashes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cracked_hashes" ADD CONSTRAINT "project_cracked_hashes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_cracked_hashes_project_mode_value_idx" ON "project_cracked_hashes" USING btree ("project_id","hashcat_mode","hash_value");--> statement-breakpoint
CREATE INDEX "project_cracked_hashes_keyset_idx" ON "project_cracked_hashes" USING btree ("project_id","hashcat_mode","cracked_at","id");