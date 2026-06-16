import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
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

// Resource lifecycle status union - duplicated from
// `../schemas/resources.ts`'s `resourceStatusSchema` to avoid a
// circular import (schemas/index.ts already imports from this file).
// Keep the two lists in sync; the canonical source is the Zod
// `resourceStatusSchema` and the test suite asserts producer values
// against that enum.
type ResourceStatusLiteral = 'pending' | 'uploading' | 'uploaded' | 'processing' | 'ready' | 'error'

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
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const projectUsers = pgTable(
  'project_users',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
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
      .references(() => projects.id, { onDelete: 'cascade' }),
    operatingSystemId: integer('operating_system_id').references(() => operatingSystems.id, {
      onDelete: 'set null',
    }),
    /**
     * Legacy plaintext bearer token. Nullable since S-H2 introduced
     * bcrypt-format tokens; new agents get NULL here and a hash in
     * `authTokenHash`. Existing agents keep their UUID until rotated.
     * Drop-column happens in a follow-up release once all agents have
     * rotated (see docs/operations/agent-token-rotation.md).
     */
    authToken: varchar('auth_token', { length: 255 }),
    /**
     * S-H2: bcrypt hash of the agent's bearer token. Populated by
     * `rotateAgentToken`; the raw token is delivered to the operator
     * exactly once and never persisted.
     */
    authTokenHash: varchar('auth_token_hash', { length: 255 }),
    /**
     * S-H2: format discriminator for `authToken` / `authTokenHash`.
     * `'plaintext'` for legacy UUID rows; `'bcrypt'` after rotation.
     * The auth middleware branches on this to choose the right verify
     * path so a partial rotation never locks an agent out.
     */
    authTokenFormat: varchar('auth_token_format', { length: 16 }).notNull().default('plaintext'),
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
    // S-H2: legacy plaintext path looks up by `auth_token` directly;
    // partial uniqueness here preserves the pre-S-H2 invariant
    // (`agents.auth_token` was UNIQUE NOT NULL) for the rows that still
    // use that path. Bcrypt-format rows have `auth_token = NULL` so
    // they are excluded from the unique constraint, leaving the column
    // free to hold many NULLs without conflict. The plain
    // `agents_auth_token_idx` is gone -- this partial unique covers
    // both the lookup and the uniqueness invariant in one index.
    uniqueIndex('agents_auth_token_plaintext_unique')
      .on(table.authToken)
      .where(sql`${table.authTokenFormat} = 'plaintext' AND ${table.authToken} IS NOT NULL`),
    // Heartbeat-monitor sweep filters by lastSeenAt to detect stale
    // agents. Without this index it does a seq scan once per sweep
    // interval (default 30s) -- linear in the agent count.
    index('agents_last_seen_at_idx').on(table.lastSeenAt),
    // S-H2: enforce the format discriminator vocabulary at the DB
    // level so a future bad migration or direct UPDATE can't land
    // 'pbkdf2' or 'plain' (typo) and silently break auth routing.
    check('agents_auth_token_format_chk', sql`${table.authTokenFormat} IN ('plaintext', 'bcrypt')`),
  ]
)

export const agentErrors = pgTable(
  'agent_errors',
  {
    id: serial('id').primaryKey(),
    agentId: integer('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
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
      .references(() => agents.id, { onDelete: 'cascade' }),
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
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    hashTypeId: integer('hash_type_id').references(() => hashTypes.id, { onDelete: 'set null' }),
    source: varchar('source', { length: 50 }).notNull().default('upload'),
    fileRef: jsonb('file_ref').default({}),
    statistics: jsonb('statistics').default({}),
    status: varchar('status', { length: 20 })
      .$type<ResourceStatusLiteral>()
      .notNull()
      .default('uploading'),
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
      .references(() => hashLists.id, { onDelete: 'cascade' }),
    hashValue: varchar('hash_value', { length: 1024 }).notNull(),
    plaintext: text('plaintext'),
    crackedAt: timestamp('cracked_at', { withTimezone: true }),
    campaignId: integer('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    attackId: integer('attack_id').references(() => attacks.id, { onDelete: 'set null' }),
    taskId: integer('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    agentId: integer('agent_id').references(() => agents.id, { onDelete: 'set null' }),
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
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  fileRef: jsonb('file_ref').default({}),
  lineCount: bigint('line_count', { mode: 'number' }),
  fileSize: bigint('file_size', { mode: 'number' }),
  status: varchar('status', { length: 20 })
    .$type<ResourceStatusLiteral>()
    .notNull()
    .default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const ruleLists = pgTable('rule_lists', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  fileRef: jsonb('file_ref').default({}),
  lineCount: bigint('line_count', { mode: 'number' }),
  fileSize: bigint('file_size', { mode: 'number' }),
  status: varchar('status', { length: 20 })
    .$type<ResourceStatusLiteral>()
    .notNull()
    .default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const maskLists = pgTable('mask_lists', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  fileRef: jsonb('file_ref').default({}),
  lineCount: bigint('line_count', { mode: 'number' }),
  fileSize: bigint('file_size', { mode: 'number' }),
  // Summed keyspace of the masklist (Σ per-line calculateMaskKeyspace), a
  // decimal string mirroring attacks.keyspace. Null when uncomputable
  // (custom-charset / unknown-token lines) or not yet counted (#231).
  keyspace: varchar('keyspace', { length: 255 }),
  status: varchar('status', { length: 20 })
    .$type<ResourceStatusLiteral>()
    .notNull()
    .default('pending'),
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
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    mode: integer('mode').notNull(),
    hashTypeId: integer('hash_type_id').references(() => hashTypes.id, { onDelete: 'set null' }),
    wordlistId: integer('wordlist_id').references(() => wordLists.id, { onDelete: 'set null' }),
    rulelistId: integer('rulelist_id').references(() => ruleLists.id, { onDelete: 'set null' }),
    masklistId: integer('masklist_id').references(() => maskLists.id, { onDelete: 'set null' }),
    advancedConfiguration: jsonb('advanced_configuration').default({}),
    tags: text('tags').array().notNull().default([]),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
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
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    hashListId: integer('hash_list_id')
      .notNull()
      .references(() => hashLists.id, { onDelete: 'restrict' }),
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    priority: integer('priority').notNull().default(5),
    progress: jsonb('progress').default({}),
    metadata: jsonb('metadata').default({}),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
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
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    mode: integer('mode').notNull(),
    hashTypeId: integer('hash_type_id').references(() => hashTypes.id, { onDelete: 'set null' }),
    wordlistId: integer('wordlist_id').references(() => wordLists.id, { onDelete: 'set null' }),
    rulelistId: integer('rulelist_id').references(() => ruleLists.id, { onDelete: 'set null' }),
    masklistId: integer('masklist_id').references(() => maskLists.id, { onDelete: 'set null' }),
    advancedConfiguration: jsonb('advanced_configuration').default({}),
    keyspace: varchar('keyspace', { length: 255 }),
    // No `status` column: attack status is derived at read time from task
    // aggregates + the campaign's status (issue #99). A persisted column would
    // race campaign auto-completion and drift against a value nothing queries.
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
      .references(() => attacks.id, { onDelete: 'cascade' }),
    campaignId: integer('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    agentId: integer('agent_id').references(() => agents.id, { onDelete: 'set null' }),
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
    // Preemption (issue #97): a non-terminal `paused` status with reason
    // tracking. `pausedReason` distinguishes task-level preemption from a
    // future campaign-level pause cascade; `preemptedByCampaignId` is the
    // higher-priority campaign that triggered the pause. `resumedAt` drives
    // the anti-thrash stability floor. A preempted task RETAINS its
    // `agentId` while paused (so the heartbeat stop-signal is derivable);
    // resume clears it.
    pausedReason: varchar('paused_reason', { length: 20 }),
    preemptedByCampaignId: integer('preempted_by_campaign_id').references(() => campaigns.id, {
      onDelete: 'set null',
    }),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    resumedAt: timestamp('resumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tasks_campaign_id_idx').on(table.campaignId),
    // The read-time attack-runtime aggregate (issue #99) filters
    // `WHERE attack_id IN (...) GROUP BY attack_id` with no campaign predicate,
    // so the campaign indexes below can't serve it. Postgres does not
    // auto-index FK columns, so this query would seq-scan the (large) tasks
    // table on every campaign-detail load and Control attack read without it.
    index('tasks_attack_id_idx').on(table.attackId),
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
    // Preemption sweep + heartbeat stop-signal both filter on
    // (agent_id, status, paused_reason). Bounding the index to preempted
    // paused rows keeps the heartbeat-derived stopTaskIds query (issue #97
    // U4) off a seq scan as paused history grows.
    index('tasks_preempted_paused_idx')
      .on(table.agentId)
      .where(sql`status = 'paused' AND paused_reason = 'preempted'`),
    // Pin the task status vocabulary at the DB level so a bad migration or
    // direct UPDATE can't land a typo'd status and silently mis-route the
    // dashboard buckets or the preemption sweep. Mirrors taskDbStatusSchema
    // in `../schemas/dashboard.ts` -- keep the two lists in sync.
    check(
      'tasks_status_chk',
      sql`${table.status} IN ('pending', 'assigned', 'running', 'paused', 'completed', 'exhausted', 'failed', 'cancelled')`
    ),
    // Pin the preemption reason vocabulary; NULL when the task was never
    // paused. Mirrors pausedReasonSchema in `../schemas/index.ts`.
    check(
      'tasks_paused_reason_chk',
      sql`${table.pausedReason} IS NULL OR ${table.pausedReason} IN ('preempted', 'campaign_paused')`
    ),
  ]
)

// Durable audit trail for preemption (issue #97 U2). Append-only: one row
// per pause/resume transition. `agent_errors` is the model for the FK +
// composite index shape; like its `task_id` FK, the FKs here use ON DELETE
// SET NULL so the audit row survives task/campaign deletion with its linkage
// cleared.
export const taskEvents = pgTable(
  'task_events',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    eventType: varchar('event_type', { length: 20 }).notNull(),
    reason: varchar('reason', { length: 20 }),
    fromStatus: varchar('from_status', { length: 20 }).notNull(),
    toStatus: varchar('to_status', { length: 20 }).notNull(),
    byCampaignId: integer('by_campaign_id').references(() => campaigns.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('task_events_task_id_created_at_idx').on(table.taskId, table.createdAt.desc()),
    check('task_events_event_type_chk', sql`${table.eventType} IN ('preempted', 'resumed')`),
    // Pin the audit row's status + reason vocabularies the same way `tasks`
    // does, so a typo or a direct UPDATE can't land an audit row that fails to
    // parse against the shared schemas later. Keep these IN-lists in sync with
    // taskDbStatusSchema (`../schemas/dashboard.ts`) and pausedReasonSchema
    // (`../schemas/index.ts`).
    check(
      'task_events_from_status_chk',
      sql`${table.fromStatus} IN ('pending', 'assigned', 'running', 'paused', 'completed', 'exhausted', 'failed', 'cancelled')`
    ),
    check(
      'task_events_to_status_chk',
      sql`${table.toStatus} IN ('pending', 'assigned', 'running', 'paused', 'completed', 'exhausted', 'failed', 'cancelled')`
    ),
    check(
      'task_events_reason_chk',
      sql`${table.reason} IS NULL OR ${table.reason} IN ('preempted', 'campaign_paused')`
    ),
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
