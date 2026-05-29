import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

// ─── Identity & Access ──────────────────────────────────────────────

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  emailVerified: boolean('email_verified').notNull().default(true),
  image: text('image'),
  apiKeyHash: varchar('api_key_hash', { length: 255 }).unique(),
  apiKeyLastUsedAt: timestamp('api_key_last_used_at', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  // Global capability tier for the dashboard API. Distinct from
  // project_users.roles (per-project membership: admin|contributor|viewer).
  // Allowed values: 'admin' | 'operator' | 'analyst'. Default 'analyst' is
  // the least-privileged tier so a forgotten role assignment fails closed;
  // the application layer always sets this explicitly on insert.
  roles: text('roles').array().notNull().default(['analyst']),
  // Last project the user explicitly selected via POST /dashboard/projects/select.
  // Read by databaseHooks.session.create.before (auth.ts) on next sign-in
  // to rehydrate session.projectId for multi-project users, after re-
  // validating membership. NULL means "no preference recorded".
  // AnyPgColumn breaks the inference cycle: `users.lastProjectId -> projects.id`
  // and `projects.createdBy -> users.id` form a loop that TypeScript can't
  // resolve, leaving both tables typed as `any` without the explicit annotation.
  lastProjectId: integer('last_project_id').references((): AnyPgColumn => projects.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const projects = pgTable('projects', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  settings: jsonb('settings').default({}),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

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
)

// ─── BetterAuth Tables ──────────────────────────────────────────────

export const baSessions = pgTable(
  'ba_sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    // Server-managed project context for the session. Set by the
    // single-project auto-select hook on sign-in, or by an explicit
    // call to POST /api/v1/dashboard/projects/select. Read by the
    // dashboard WebSocket upgrade to scope event broadcasts without
    // trusting a client-supplied query param. Nullable so multi-project
    // users land without a default until they pick one.
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ba_sessions_user_id_idx').on(table.userId)]
)

export const baAccounts = pgTable(
  'ba_accounts',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
    }),
    scope: text('scope'),
    idToken: text('id_token'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ba_accounts_user_id_idx').on(table.userId),
    uniqueIndex('ba_accounts_user_id_provider_id_idx').on(table.userId, table.providerId),
  ]
)

export const baVerifications = pgTable(
  'ba_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ba_verifications_identifier_idx').on(table.identifier)]
)

// ─── Agents & Telemetry ─────────────────────────────────────────────

export const operatingSystems = pgTable('operating_systems', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  version: varchar('version', { length: 100 }),
  platform: varchar('platform', { length: 100 }),
})

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
    /**
     * @deprecated Use `capabilities.engines[]` (and the `cracker_binaries`
     * registry) for engine + version tracking. This column is kept for
     * back-compat with agents that have not adopted `engines[]` yet and
     * will be removed in a follow-up cleanup once all agents emit the new
     * field.
     *
     * Removal is tracked alongside #94 (Cracker Binary Management); once
     * the agent project emits `engines[]` in heartbeat capabilities, drop
     * this column and any callers reading it.
     */
    crackerVersion: varchar('cracker_version', { length: 100 }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agents_project_id_idx').on(table.projectId),
    index('agents_status_idx').on(table.status),
    index('agents_auth_token_idx').on(table.authToken),
    // Heartbeat-monitor sweep filters by lastSeenAt to detect stale
    // agents. Without this index it does a seq scan once per sweep
    // interval (default 30s) -- linear in the agent count.
    index('agents_last_seen_at_idx').on(table.lastSeenAt),
  ]
)

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
    // FK with ON DELETE SET NULL: when a task is deleted, the audit row
    // is retained but its task linkage is cleared. Service-side ownership
    // checks (services/agents.ts `processHeartbeat`) prevent agents from
    // attributing errors to tasks they don't own; the FK is the
    // last-line guard so dangling task_ids cannot accumulate.
    taskId: integer('task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Composite index supports both the 24h window scan
    // (aggregateRecentErrors in services/agents.ts) and the ORDER BY
    // created_at DESC LIMIT path in getAgentErrors. Subsumes the previous
    // single-column agent_id index, which is dropped in the migration.
    index('agent_errors_agent_id_created_at_idx').on(table.agentId, table.createdAt.desc()),
  ]
)

export const agentBenchmarks = pgTable(
  'agent_benchmarks',
  {
    id: serial('id').primaryKey(),
    agentId: integer('agent_id')
      .notNull()
      .references(() => agents.id),
    hashcatMode: integer('hashcat_mode').notNull(),
    hashType: varchar('hash_type', { length: 255 }).notNull(),
    speedHs: bigint('speed_hs', { mode: 'number' }).notNull(),
    deviceName: varchar('device_name', { length: 255 }).notNull(),
    benchmarkedAt: timestamp('benchmarked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_benchmarks_agent_id_idx').on(table.agentId),
    uniqueIndex('agent_benchmarks_agent_id_hashcat_mode_idx').on(table.agentId, table.hashcatMode),
  ]
)

// ─── Resources ──────────────────────────────────────────────────────

export const hashTypes = pgTable('hash_types', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  hashcatMode: integer('hashcat_mode').notNull().unique(),
  category: varchar('category', { length: 100 }),
  example: text('example'),
})

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
)

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
)

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
})

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
})

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
})

// ─── Attack Templates ──────────────────────────────────────────────

export const attackTemplates = pgTable(
  'attack_templates',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    mode: integer('mode').notNull(),
    hashTypeId: integer('hash_type_id').references(() => hashTypes.id),
    wordlistId: integer('wordlist_id').references(() => wordLists.id),
    rulelistId: integer('rulelist_id').references(() => ruleLists.id),
    masklistId: integer('masklist_id').references(() => maskLists.id),
    advancedConfiguration: jsonb('advanced_configuration').default({}),
    tags: text('tags').array().notNull().default([]),
    createdBy: integer('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('attack_templates_project_name_idx').on(table.projectId, table.name),
    index('attack_templates_project_id_idx').on(table.projectId),
  ]
)

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
)

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
)

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
    retryCount: integer('retry_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tasks_campaign_id_idx').on(table.campaignId),
    index('tasks_agent_id_idx').on(table.agentId),
    index('tasks_status_idx').on(table.status),
    index('tasks_status_campaign_id_idx').on(table.status, table.campaignId),
    index('tasks_campaign_id_status_idx').on(table.campaignId, table.status),
    // P-H3: assignNextTask + heartbeat hint filter by JSONB
    // requiredCapabilities. Without expression indexes, the planner
    // falls back to filtering each candidate row by parsing the JSONB
    // -- O(unassigned_pending_tasks) per claim at 10-50 claims/sec
    // hits 100-300ms p99 with 100K pending tasks.
    index('tasks_required_capabilities_gpu_idx').on(sql`((required_capabilities ->> 'gpu'))`),
    // Indexed on the casted int expression so the planner can use it
    // for the actual hot-path predicate, which does
    // `(required_capabilities ->> 'hashcatMode')::int = ANY(...)`
    // (services/tasks.ts buildCapabilityPredicate). Postgres expression
    // indexes only match when the indexed expression matches the
    // query expression exactly -- a text-only index would never be
    // used here despite looking correct on paper.
    index('tasks_required_capabilities_hashcat_mode_idx').on(
      sql`(((required_capabilities ->> 'hashcatMode'))::int)`
    ),
    // Partial index for the assignNextTask hot path: the planner
    // scans pending/unassigned tasks per claim. Bounding the index
    // to (status='pending' AND agent_id IS NULL) keeps it tiny
    // even as completed task history grows.
    index('tasks_pending_unassigned_idx')
      .on(table.campaignId, table.id)
      .where(sql`status = 'pending' AND agent_id IS NULL`),
  ]
)

// ─── Cracker Binaries ───────────────────────────────────────────────

export const crackerBinaries = pgTable(
  'cracker_binaries',
  {
    id: serial('id').primaryKey(),
    engine: varchar('engine', { length: 50 }).notNull().default('hashcat'),
    version: varchar('version', { length: 100 }).notNull(),
    platform: varchar('platform', { length: 64 }).notNull(),
    fileRef: jsonb('file_ref').default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('cracker_binaries_engine_version_platform_idx').on(
      table.engine,
      table.version,
      table.platform
    ),
    index('cracker_binaries_engine_platform_idx').on(table.engine, table.platform),
    index('cracker_binaries_is_active_idx').on(table.isActive),
  ]
)
