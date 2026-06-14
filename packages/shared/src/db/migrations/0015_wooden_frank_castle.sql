CREATE TABLE "task_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer,
	"event_type" varchar(20) NOT NULL,
	"reason" varchar(20),
	"from_status" varchar(20) NOT NULL,
	"to_status" varchar(20) NOT NULL,
	"by_campaign_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_events_event_type_chk" CHECK ("task_events"."event_type" IN ('preempted', 'resumed'))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "paused_reason" varchar(20);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "preempted_by_campaign_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "resumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_by_campaign_id_campaigns_id_fk" FOREIGN KEY ("by_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_events_task_id_created_at_idx" ON "task_events" USING btree ("task_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_preempted_by_campaign_id_campaigns_id_fk" FOREIGN KEY ("preempted_by_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_preempted_paused_idx" ON "tasks" USING btree ("agent_id") WHERE status = 'paused' AND paused_reason = 'preempted';--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_chk" CHECK ("tasks"."status" IN ('pending', 'assigned', 'running', 'paused', 'completed', 'exhausted', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_paused_reason_chk" CHECK ("tasks"."paused_reason" IS NULL OR "tasks"."paused_reason" IN ('preempted', 'campaign_paused'));
