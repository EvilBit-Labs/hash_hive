CREATE TABLE "cracker_binaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"engine" varchar(50) DEFAULT 'hashcat' NOT NULL,
	"version" varchar(100) NOT NULL,
	"platform" varchar(64) NOT NULL,
	"file_ref" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cracker_binaries_engine_version_platform_idx" ON "cracker_binaries" USING btree ("engine","version","platform");--> statement-breakpoint
CREATE INDEX "cracker_binaries_engine_platform_idx" ON "cracker_binaries" USING btree ("engine","platform");--> statement-breakpoint
CREATE INDEX "cracker_binaries_is_active_idx" ON "cracker_binaries" USING btree ("is_active");
