import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

// ─── Identity & Access ──────────────────────────────────────────────

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  settings: jsonb('settings').default({}),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectUsers = pgTable(
  'project_users',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    roles: text('roles').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('project_users_user_project_idx').on(table.userId, table.projectId)]
);

// ─── Agents & Telemetry ─────────────────────────────────────────────

export const operatingSystems = pgTable('operating_systems', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  version: varchar('version', { length: 100 }),
  platform: varchar('platform', { length: 100 }),
});

export const agents = pgTable(
  'agents',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    operatingSystemId: integer('operating_system_id').references(() => operatingSystems.id),
    authToken: varchar('auth_token', { length: 255 }).notNull().unique(),
    status: varchar('status', { length: 20 }).notNull().default('offline'),
    capabilities: jsonb('capabilities').default({}),
    hardwareProfile: jsonb('hardware_profile').default({}),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agents_project_id_idx').on(table.projectId),
    index('agents_status_idx').on(table.status),
  ]
);

export const agentErrors = pgTable(
  'agent_errors',
  {
    id: serial('id').primaryKey(),
    agentId: integer('agent_id')
      .notNull()
      .references(() => agents.id),
    severity: varchar('severity', { length: 20 }).notNull().default('error'),
    message: text('message').notNull(),
    context: jsonb('context').default({}),
    taskId: integer('task_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('agent_errors_agent_id_idx').on(table.agentId)]
);

// ─── Resources ──────────────────────────────────────────────────────

export const hashTypes = pgTable('hash_types', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  hashcatMode: integer('hashcat_mode').notNull().unique(),
  category: varchar('category', { length: 100 }),
  example: text('example'),
});

export const hashLists = pgTable(
  'hash_lists',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    name: varchar('name', { length: 255 }).notNull(),
    hashTypeId: integer('hash_type_id').references(() => hashTypes.id),
    source: varchar('source', { length: 50 }).notNull().default('upload'),
    fileRef: jsonb('file_ref').default({}),
    statistics: jsonb('statistics').default({}),
    status: varchar('status', { length: 20 }).notNull().default('uploading'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('hash_lists_project_id_idx').on(table.projectId),
    index('hash_lists_status_idx').on(table.status),
  ]
);

export const hashItems = pgTable(
  'hash_items',
  {
    id: serial('id').primaryKey(),
    hashListId: integer('hash_list_id')
      .notNull()
      .references(() => hashLists.id),
    hashValue: varchar('hash_value', { length: 1024 }).notNull(),
    plaintext: text('plaintext'),
    crackedAt: timestamp('cracked_at', { withTimezone: true }),
    campaignId: integer('campaign_id').references(() => campaigns.id),
    attackId: integer('attack_id').references(() => attacks.id),
    taskId: integer('task_id').references(() => tasks.id),
    agentId: integer('agent_id').references(() => agents.id),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hash_items_hash_list_id_hash_value_idx').on(table.hashListId, table.hashValue),
    index('hash_items_hash_list_id_idx').on(table.hashListId),
    index('hash_items_cracked_at_idx').on(table.crackedAt),
    index('hash_items_campaign_id_idx').on(table.campaignId),
    index('hash_items_hash_list_cracked_idx').on(table.hashListId, table.crackedAt),
  ]
);

export const wordLists = pgTable('word_lists', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id),
  name: varchar('name', { length: 255 }).notNull(),
  fileRef: jsonb('file_ref').default({}),
  lineCount: bigint('line_count', { mode: 'number' }),
  fileSize: bigint('file_size', { mode: 'number' }),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ruleLists = pgTable('rule_lists', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id),
  name: varchar('name', { length: 255 }).notNull(),
  fileRef: jsonb('file_ref').default({}),
  lineCount: bigint('line_count', { mode: 'number' }),
  fileSize: bigint('file_size', { mode: 'number' }),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const maskLists = pgTable('mask_lists', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id),
  name: varchar('name', { length: 255 }).notNull(),
  fileRef: jsonb('file_ref').default({}),
  lineCount: bigint('line_count', { mode: 'number' }),
  fileSize: bigint('file_size', { mode: 'number' }),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Campaign Orchestration ─────────────────────────────────────────

export const campaigns = pgTable(
  'campaigns',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    hashListId: integer('hash_list_id')
      .notNull()
      .references(() => hashLists.id),
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    priority: integer('priority').notNull().default(5),
    progress: jsonb('progress').default({}),
    metadata: jsonb('metadata').default({}),
    createdBy: integer('created_by').references(() => users.id),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('campaigns_project_id_status_idx').on(table.projectId, table.status)]
);

export const attacks = pgTable(
  'attacks',
  {
    id: serial('id').primaryKey(),
    campaignId: integer('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    mode: integer('mode').notNull(),
    hashTypeId: integer('hash_type_id').references(() => hashTypes.id),
    wordlistId: integer('wordlist_id').references(() => wordLists.id),
    rulelistId: integer('rulelist_id').references(() => ruleLists.id),
    masklistId: integer('masklist_id').references(() => maskLists.id),
    advancedConfiguration: jsonb('advanced_configuration').default({}),
    keyspace: varchar('keyspace', { length: 255 }),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    dependencies: integer('dependencies').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('attacks_campaign_id_idx').on(table.campaignId)]
);

export const tasks = pgTable(
  'tasks',
  {
    id: serial('id').primaryKey(),
    attackId: integer('attack_id')
      .notNull()
      .references(() => attacks.id),
    campaignId: integer('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    agentId: integer('agent_id').references(() => agents.id),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    workRange: jsonb('work_range').default({}),
    progress: jsonb('progress').default({}),
    resultStats: jsonb('result_stats').default({}),
    requiredCapabilities: jsonb('required_capabilities').default({}),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tasks_campaign_id_idx').on(table.campaignId),
    index('tasks_agent_id_idx').on(table.agentId),
    index('tasks_status_idx').on(table.status),
    index('tasks_status_campaign_id_idx').on(table.status, table.campaignId),
  ]
);
