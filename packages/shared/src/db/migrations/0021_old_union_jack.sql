ALTER TABLE "agents" ADD COLUMN "enrolled_by_token_id" integer;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_enrolled_by_token_id_enrollment_tokens_id_fk" FOREIGN KEY ("enrolled_by_token_id") REFERENCES "public"."enrollment_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_reusable_max_uses_chk" CHECK ("enrollment_tokens"."is_reusable" OR "enrollment_tokens"."max_uses" IS NULL);--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_use_count_le_max_uses_chk" CHECK ("enrollment_tokens"."max_uses" IS NULL OR "enrollment_tokens"."use_count" <= "enrollment_tokens"."max_uses");
