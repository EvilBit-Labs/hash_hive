ALTER TABLE "users" ADD COLUMN "api_key_hash" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "api_key_last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_api_key_hash_unique" UNIQUE("api_key_hash");
