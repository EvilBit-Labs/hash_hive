ALTER TABLE "agents" DROP CONSTRAINT "agents_auth_token_unique";--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "auth_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auth_token_hash" varchar(255);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auth_token_format" varchar(16) DEFAULT 'plaintext' NOT NULL;--> statement-breakpoint
CREATE INDEX "agents_auth_token_format_idx" ON "agents" USING btree ("auth_token_format");
