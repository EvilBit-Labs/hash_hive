ALTER TABLE "agent_benchmarks" DROP CONSTRAINT "agent_benchmarks_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_errors" DROP CONSTRAINT "agent_errors_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_operating_system_id_operating_systems_id_fk";
--> statement-breakpoint
ALTER TABLE "attack_templates" DROP CONSTRAINT "attack_templates_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "attack_templates" DROP CONSTRAINT "attack_templates_hash_type_id_hash_types_id_fk";
--> statement-breakpoint
ALTER TABLE "attack_templates" DROP CONSTRAINT "attack_templates_wordlist_id_word_lists_id_fk";
--> statement-breakpoint
ALTER TABLE "attack_templates" DROP CONSTRAINT "attack_templates_rulelist_id_rule_lists_id_fk";
--> statement-breakpoint
ALTER TABLE "attack_templates" DROP CONSTRAINT "attack_templates_masklist_id_mask_lists_id_fk";
--> statement-breakpoint
ALTER TABLE "attack_templates" DROP CONSTRAINT "attack_templates_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "attacks" DROP CONSTRAINT "attacks_campaign_id_campaigns_id_fk";
--> statement-breakpoint
ALTER TABLE "attacks" DROP CONSTRAINT "attacks_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "attacks" DROP CONSTRAINT "attacks_hash_type_id_hash_types_id_fk";
--> statement-breakpoint
ALTER TABLE "attacks" DROP CONSTRAINT "attacks_wordlist_id_word_lists_id_fk";
--> statement-breakpoint
ALTER TABLE "attacks" DROP CONSTRAINT "attacks_rulelist_id_rule_lists_id_fk";
--> statement-breakpoint
ALTER TABLE "attacks" DROP CONSTRAINT "attacks_masklist_id_mask_lists_id_fk";
--> statement-breakpoint
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_hash_list_id_hash_lists_id_fk";
--> statement-breakpoint
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "hash_items" DROP CONSTRAINT "hash_items_hash_list_id_hash_lists_id_fk";
--> statement-breakpoint
ALTER TABLE "hash_items" DROP CONSTRAINT "hash_items_campaign_id_campaigns_id_fk";
--> statement-breakpoint
ALTER TABLE "hash_items" DROP CONSTRAINT "hash_items_attack_id_attacks_id_fk";
--> statement-breakpoint
ALTER TABLE "hash_items" DROP CONSTRAINT "hash_items_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "hash_items" DROP CONSTRAINT "hash_items_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "hash_lists" DROP CONSTRAINT "hash_lists_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "hash_lists" DROP CONSTRAINT "hash_lists_hash_type_id_hash_types_id_fk";
--> statement-breakpoint
ALTER TABLE "mask_lists" DROP CONSTRAINT "mask_lists_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "project_users" DROP CONSTRAINT "project_users_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "project_users" DROP CONSTRAINT "project_users_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "rule_lists" DROP CONSTRAINT "rule_lists_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_attack_id_attacks_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_campaign_id_campaigns_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "word_lists" DROP CONSTRAINT "word_lists_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_benchmarks" ADD CONSTRAINT "agent_benchmarks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_errors" ADD CONSTRAINT "agent_errors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_operating_system_id_operating_systems_id_fk" FOREIGN KEY ("operating_system_id") REFERENCES "public"."operating_systems"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_hash_type_id_hash_types_id_fk" FOREIGN KEY ("hash_type_id") REFERENCES "public"."hash_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_wordlist_id_word_lists_id_fk" FOREIGN KEY ("wordlist_id") REFERENCES "public"."word_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_rulelist_id_rule_lists_id_fk" FOREIGN KEY ("rulelist_id") REFERENCES "public"."rule_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_masklist_id_mask_lists_id_fk" FOREIGN KEY ("masklist_id") REFERENCES "public"."mask_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attack_templates" ADD CONSTRAINT "attack_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_hash_type_id_hash_types_id_fk" FOREIGN KEY ("hash_type_id") REFERENCES "public"."hash_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_wordlist_id_word_lists_id_fk" FOREIGN KEY ("wordlist_id") REFERENCES "public"."word_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_rulelist_id_rule_lists_id_fk" FOREIGN KEY ("rulelist_id") REFERENCES "public"."rule_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attacks" ADD CONSTRAINT "attacks_masklist_id_mask_lists_id_fk" FOREIGN KEY ("masklist_id") REFERENCES "public"."mask_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_hash_list_id_hash_lists_id_fk" FOREIGN KEY ("hash_list_id") REFERENCES "public"."hash_lists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_items" ADD CONSTRAINT "hash_items_hash_list_id_hash_lists_id_fk" FOREIGN KEY ("hash_list_id") REFERENCES "public"."hash_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_items" ADD CONSTRAINT "hash_items_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_items" ADD CONSTRAINT "hash_items_attack_id_attacks_id_fk" FOREIGN KEY ("attack_id") REFERENCES "public"."attacks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_items" ADD CONSTRAINT "hash_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_items" ADD CONSTRAINT "hash_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_lists" ADD CONSTRAINT "hash_lists_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hash_lists" ADD CONSTRAINT "hash_lists_hash_type_id_hash_types_id_fk" FOREIGN KEY ("hash_type_id") REFERENCES "public"."hash_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mask_lists" ADD CONSTRAINT "mask_lists_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_users" ADD CONSTRAINT "project_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_users" ADD CONSTRAINT "project_users_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_lists" ADD CONSTRAINT "rule_lists_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_attack_id_attacks_id_fk" FOREIGN KEY ("attack_id") REFERENCES "public"."attacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_lists" ADD CONSTRAINT "word_lists_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
