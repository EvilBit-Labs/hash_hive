CREATE TABLE "fleet_agent_config" (
	"id" integer PRIMARY KEY NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_agent_config_singleton_chk" CHECK ("fleet_agent_config"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_entity_type_chk";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_entity_type_chk" CHECK ("audit_logs"."entity_type" IN ('project', 'campaign', 'attack', 'hash_list', 'word_list', 'rule_list', 'mask_list', 'agent', 'fleet_config'));
