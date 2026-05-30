ALTER TABLE "agents" DROP CONSTRAINT "agents_auth_token_unique";--> statement-breakpoint
DROP INDEX "agents_auth_token_idx";--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "auth_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auth_token_hash" varchar(255);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auth_token_format" varchar(16) DEFAULT 'plaintext' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_auth_token_plaintext_unique" ON "agents" USING btree ("auth_token") WHERE "agents"."auth_token_format" = 'plaintext' AND "agents"."auth_token" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_auth_token_format_chk" CHECK ("agents"."auth_token_format" IN ('plaintext', 'bcrypt'));
