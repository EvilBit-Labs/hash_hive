CREATE TABLE "ldap_link_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(255) NOT NULL,
	"derived_email" varchar(255) NOT NULL,
	"resolved_role" varchar(20) NOT NULL,
	"matched_user_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ldap_link_requests_status_chk" CHECK ("ldap_link_requests"."status" IN ('pending', 'linked', 'rejected')),
	CONSTRAINT "ldap_link_requests_resolved_role_chk" CHECK ("ldap_link_requests"."resolved_role" IN ('admin', 'operator', 'analyst'))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_entity_type_chk";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_action_chk";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ldap_link_requests" ADD CONSTRAINT "ldap_link_requests_matched_user_id_users_id_fk" FOREIGN KEY ("matched_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ldap_link_requests_status_idx" ON "ldap_link_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ldap_link_requests_username_idx" ON "ldap_link_requests" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "ba_accounts_provider_id_account_id_idx" ON "ba_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_entity_type_chk" CHECK ("audit_logs"."entity_type" IN ('project', 'campaign', 'attack', 'hash_list', 'word_list', 'rule_list', 'mask_list', 'agent', 'fleet_config', 'user'));--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_chk" CHECK ("audit_logs"."action" IN ('created', 'updated', 'deleted', 'status_changed', 'token_issued', 'archived', 'restored', 'retired', 'reclaimed', 'ldap.provisioned', 'ldap.role_synced', 'ldap.collision'));
