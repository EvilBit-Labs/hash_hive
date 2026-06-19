CREATE TABLE "task_telemetry" (
	"time" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" integer NOT NULL,
	"agent_id" integer,
	"keyspace_progress" bigint NOT NULL,
	"speed_hs" bigint,
	"temperature" real
);
--> statement-breakpoint
ALTER TABLE "task_telemetry" ADD CONSTRAINT "task_telemetry_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_telemetry" ADD CONSTRAINT "task_telemetry_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_telemetry_task_id_time_idx" ON "task_telemetry" USING btree ("task_id","time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_telemetry_time_idx" ON "task_telemetry" USING btree ("time" DESC NULLS LAST);
