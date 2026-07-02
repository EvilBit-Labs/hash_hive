ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_action_chk";--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_chk" CHECK ("audit_logs"."action" IN ('created', 'updated', 'deleted', 'status_changed', 'token_issued', 'archived', 'restored', 'retired', 'reclaimed'));
