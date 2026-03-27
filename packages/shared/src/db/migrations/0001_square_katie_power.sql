CREATE TABLE "agent_benchmarks" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"hashcat_mode" integer NOT NULL,
	"hash_type" varchar(255) NOT NULL,
	"speed_hs" bigint NOT NULL,
	"device_name" varchar(255) NOT NULL,
	"benchmarked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "cracker_version" varchar(100);--> statement-breakpoint
ALTER TABLE "agent_benchmarks" ADD CONSTRAINT "agent_benchmarks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_benchmarks_agent_id_idx" ON "agent_benchmarks" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_benchmarks_agent_id_hashcat_mode_idx" ON "agent_benchmarks" USING btree ("agent_id","hashcat_mode");
