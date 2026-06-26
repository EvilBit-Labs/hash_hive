CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_type" varchar(20) NOT NULL,
	"actor_id" integer,
	"project_id" integer,
	"entity_type" varchar(32) NOT NULL,
	"entity_id" integer NOT NULL,
	"action" varchar(20) NOT NULL,
	"from_status" varchar(20),
	"to_status" varchar(20),
	"reason" varchar(40),
	"changes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_actor_type_chk" CHECK ("audit_logs"."actor_type" IN ('user', 'agent', 'system')),
	CONSTRAINT "audit_logs_entity_type_chk" CHECK ("audit_logs"."entity_type" IN ('project', 'campaign', 'attack', 'hash_list', 'word_list', 'rule_list', 'mask_list', 'agent')),
	CONSTRAINT "audit_logs_action_chk" CHECK ("audit_logs"."action" IN ('created', 'updated', 'deleted', 'status_changed', 'token_issued'))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_project_id_created_at_idx" ON "audit_logs" USING btree ("project_id","created_at" DESC NULLS LAST);
