CREATE TABLE "ba_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ba_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ba_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "ba_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mask_lists" ALTER COLUMN "line_count" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "mask_lists" ALTER COLUMN "file_size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "rule_lists" ALTER COLUMN "line_count" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "rule_lists" ALTER COLUMN "file_size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "word_lists" ALTER COLUMN "line_count" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "word_lists" ALTER COLUMN "file_size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "mask_lists" ADD COLUMN "status" varchar(20) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "rule_lists" ADD COLUMN "status" varchar(20) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "word_lists" ADD COLUMN "status" varchar(20) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "ba_accounts" ADD CONSTRAINT "ba_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ba_sessions" ADD CONSTRAINT "ba_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ba_accounts_user_id_idx" ON "ba_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ba_accounts_user_id_provider_id_idx" ON "ba_accounts" USING btree ("user_id","provider_id");--> statement-breakpoint
CREATE INDEX "ba_sessions_user_id_idx" ON "ba_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ba_verifications_identifier_idx" ON "ba_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "agents_auth_token_idx" ON "agents" USING btree ("auth_token");--> statement-breakpoint
CREATE INDEX "hash_items_hash_list_cracked_idx" ON "hash_items" USING btree ("hash_list_id","cracked_at");--> statement-breakpoint
CREATE INDEX "tasks_campaign_id_status_idx" ON "tasks" USING btree ("campaign_id","status");
