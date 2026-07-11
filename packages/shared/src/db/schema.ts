import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
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
    /**
     * Agent lifecycle status. No DB check constraint enforces the
     * vocabulary (unlike the lifecycle-marker tables' archive-consistency
     * checks) — validation lives entirely in `agentStatusSchema`
     * (`@hashhive/shared`): 'offline' | 'online' | 'busy' | 'error' |
     * 'benchmarked' | 'retired'. `retired` (issue #106 U8) is terminal and
     * server-set-only via `retireAgent`; the row and its full history
     * (tasks, benchmarks, errors) are retained, never deleted (R9). See
     * `decideHeartbeatTransition` for the guard that keeps a heartbeat
     * from a still-running rig from un-retiring the row.
     */
    status: varchar('status', { length: 20 }).notNull().default('offline'),
    capabilities: jsonb('capabilities').default({}),
    hardwareProfile: jsonb('hardware_profile').default({}),
    // Per-rig advanced hashcat configuration (#104): engine tuning knobs,
    // hardware-bound knobs, and the per-rig error whitelist. Shape validated
    // by agentConfigSchema in ../schemas; resolved against the fleet default.
    config: jsonb('config').default({}),
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
    /**
     * Stable agent-supplied identifier used to make enrollment
     * idempotent. The agent persists this on first boot and sends it on
     * every `/enroll` call. A dropped enrollment response (agent never
     * received its bearer token) is retried with the same client id, and
     * the enrollment service re-issues a bearer for the existing row
     * instead of minting a duplicate agent. NULL for legacy/migrated
     * agents that predate enrollment. Uniqueness is per-project (see the
     * partial unique index below).
     */
    enrollmentClientId: varchar('enrollment_client_id', { length: 255 }),
    /**
     * The enrollment token that originally enrolled this agent. Binds the
     * agent to its token so only that token can re-issue the agent's bearer
     * on an idempotent retry — a different (or revoked) token presenting the
     * same client id cannot re-credential (and thereby rotate/DoS) this
     * agent. NULL for legacy/migrated agents that predate enrollment; such
     * rows are never reachable via `/enroll` (they have a NULL client id).
     * `set null` on delete keeps the agent if its token row is ever removed
     * (tokens are normally revoked, not deleted).
     */
    enrolledByTokenId: integer('enrolled_by_token_id').references(() => enrollmentTokens.id, {
      onDelete: 'set null',
    }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agents_project_id_idx').on(table.projectId),
    index('agents_status_idx').on(table.status),
    // Idempotent enrollment: at most one agent per (project, client id).
    // Partial so the many legacy/migrated agents with a NULL client id
    // do not collide with each other.
    uniqueIndex('agents_project_enrollment_client_unique')
      .on(table.projectId, table.enrollmentClientId)
      .where(sql`${table.enrollmentClientId} IS NOT NULL`),
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
    // EWMA of observed throughput from live progress reports (U6).
    // Null until the agent sends at least one speed sample.
    // Seeded from speed_hs on the first sample via atomic SQL COALESCE.
    observedSpeedHs: bigint('observed_speed_hs', { mode: 'number' }),
    deviceName: varchar('device_name', { length: 255 }).notNull(),
    benchmarkedAt: timestamp('benchmarked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_benchmarks_agent_id_idx').on(table.agentId),
    uniqueIndex('agent_benchmarks_agent_id_hashcat_mode_idx').on(table.agentId, table.hashcatMode),
  ]
)

/**
 * Enrollment tokens — the typeable, short-lived credential an admin mints
 * and hands to a new agent. The agent presents it once at `/enroll`; the
 * server validates + consumes it and issues the agent its long-lived
 * per-agent bearer token (`agents.auth_token_hash`). One-time tokens are
 * consumed on first successful claim; reusable tokens enroll many agents
 * (optionally capped by `max_uses`). Only the bcrypt hash of the secret
 * is stored — the raw `etk_<id>_<word-phrase>` token is shown once at
 * mint time and never persisted. Project-scoped: enrolled agents join
 * the token's project.
 */
export const enrollmentTokens = pgTable(
  'enrollment_tokens',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Operator-facing label so a token is recognizable in the list
    // (e.g. "rack-3 rigs"). Optional.
    label: varchar('label', { length: 255 }),
    // bcrypt hash of the word-phrase secret portion. Same cost as agent
    // bearer tokens and Control API keys so no surface is the weak link.
    // The raw token is delivered to the operator exactly once.
    secretHash: varchar('secret_hash', { length: 255 }).notNull(),
    // false = one-time (consumed on first claim); true = reusable.
    isReusable: boolean('is_reusable').notNull().default(false),
    // Optional cap on a reusable token. NULL = unlimited (reusable) or
    // unused (one-time, which is implicitly single-use).
    maxUses: integer('max_uses'),
    useCount: integer('use_count').notNull().default(0),
    // Absolute UTC expiry; NULL = never expires.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // Revocation is a timestamp (not a boolean) to preserve an audit
    // trail of when the token was killed. NULL = active.
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdByUserId: integer('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('enrollment_tokens_project_id_idx').on(table.projectId),
    // Guard the counters at the DB level so a bad migration or direct
    // UPDATE cannot land a negative or zero-capped token that the atomic
    // claim guard would then reason about incorrectly.
    check('enrollment_tokens_use_count_chk', sql`${table.useCount} >= 0`),
    check('enrollment_tokens_max_uses_chk', sql`${table.maxUses} IS NULL OR ${table.maxUses} > 0`),
    // A one-time token must not carry a usage cap (max_uses is only
    // meaningful for reusable tokens). Keeps an illegal combination out of
    // the table even via a direct UPDATE or a bad migration.
    check(
      'enrollment_tokens_reusable_max_uses_chk',
      sql`${table.isReusable} OR ${table.maxUses} IS NULL`
    ),
    // use_count can never exceed the cap. The atomic claim guard reads
    // `use_count < max_uses`; enforce the ceiling at the DB level too.
    check(
      'enrollment_tokens_use_count_le_max_uses_chk',
      sql`${table.maxUses} IS NULL OR ${table.useCount} <= ${table.maxUses}`
    ),
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
    // Latches true the first time this hash list is referenced by a campaign and
    // is never cleared. Governs deletability: hard-deletable only while false.
    // See ADR-0019.
    isPermanent: boolean('is_permanent').notNull().default(false),
    // Set when a permanent hash list is archived (hidden from active views),
    // cleared on restore. NULL = not archived. See ADR-0019.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('hash_lists_project_id_idx').on(table.projectId),
    index('hash_lists_status_idx').on(table.status),
    // A row may only carry archived_at when it is permanent and in the `ready`
    // terminal state (a resource is only referenceable — hence permanent — once
    // ready). Closes off illegal combinations (archived draft/in-flight).
    check(
      'hash_lists_archive_consistency_chk',
      sql`${table.archivedAt} IS NULL OR (${table.isPermanent} = true AND ${table.status} = 'ready')`
    ),
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
    username: varchar('username', { length: 255 }),
    source: varchar('source', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hash_items_hash_list_id_hash_value_idx').on(table.hashListId, table.hashValue),
    index('hash_items_hash_list_id_idx').on(table.hashListId),
    index('hash_items_cracked_at_idx').on(table.crackedAt),
    index('hash_items_campaign_id_idx').on(table.campaignId),
    index('hash_items_hash_list_cracked_idx').on(table.hashListId, table.crackedAt),
    index('hash_items_hash_value_idx').on(table.hashValue),
    // `source` is a fixed vocabulary: 'upload' (parser), 'import' (import worker),
    // or NULL (propagated rows). Pin it at the DB so a future code path can't
    // write an unknown value.
    check(
      'hash_items_source_chk',
      sql`${table.source} IS NULL OR ${table.source} IN ('upload', 'import')`
    ),
  ]
)

export const wordLists = pgTable(
  'word_lists',
  {
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
    // ADR-0019 lifecycle markers. `is_permanent` latches on first reference by an
    // attack; `archived_at` hides a permanent resource from active views (cleared
    // on restore). See ADR-0019.
    isPermanent: boolean('is_permanent').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // Set by the blob-reclamation sweep after the retention window: the object
    // store blob has been purged while the row and attribution are kept. NULL =
    // blob still present. See #106.
    blobReclaimedAt: timestamp('blob_reclaimed_at', { withTimezone: true }),
    // SHA-256 of the uploaded file, captured at finalization and retained through
    // archive/reclaim so a reclaimed resource can be restored by re-upload.
    fileChecksum: varchar('file_checksum', { length: 255 }),
    // How the object-store blob is encoded at rest (e.g. 'none', 'gzip'). Drives
    // whether a consumer must decompress before use. See #108.
    compressionEncoding: varchar('compression_encoding', { length: 32 }).notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'word_lists_archive_consistency_chk',
      sql`${table.archivedAt} IS NULL OR (${table.isPermanent} = true AND ${table.status} = 'ready')`
    ),
  ]
)

export const ruleLists = pgTable(
  'rule_lists',
  {
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
    // ADR-0019 lifecycle markers; see wordLists for semantics.
    isPermanent: boolean('is_permanent').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    blobReclaimedAt: timestamp('blob_reclaimed_at', { withTimezone: true }),
    fileChecksum: varchar('file_checksum', { length: 255 }),
    // How the object-store blob is encoded at rest (e.g. 'none', 'gzip'). Drives
    // whether a consumer must decompress before use. See #108.
    compressionEncoding: varchar('compression_encoding', { length: 32 }).notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'rule_lists_archive_consistency_chk',
      sql`${table.archivedAt} IS NULL OR (${table.isPermanent} = true AND ${table.status} = 'ready')`
    ),
  ]
)

export const maskLists = pgTable(
  'mask_lists',
  {
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
    // ADR-0019 lifecycle markers; see wordLists for semantics.
    isPermanent: boolean('is_permanent').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    blobReclaimedAt: timestamp('blob_reclaimed_at', { withTimezone: true }),
    fileChecksum: varchar('file_checksum', { length: 255 }),
    // How the object-store blob is encoded at rest (e.g. 'none', 'gzip'). Drives
    // whether a consumer must decompress before use. See #108.
    compressionEncoding: varchar('compression_encoding', { length: 32 }).notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'mask_lists_archive_consistency_chk',
      sql`${table.archivedAt} IS NULL OR (${table.isPermanent} = true AND ${table.status} = 'ready')`
    ),
  ]
)

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
    // Latches true the first time a campaign leaves `draft` (see
    // services/campaigns.ts transitionCampaign) and is never cleared. Governs
    // deletability: a campaign is hard-deletable only while this is false.
    // Cannot be derived from `status` because editing returns a permanent
    // campaign to `draft` (running/paused -> draft). See ADR-0019.
    isPermanent: boolean('is_permanent').notNull().default(false),
    priority: integer('priority').notNull().default(5),
    progress: jsonb('progress').default({}),
    metadata: jsonb('metadata').default({}),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    // Set when a completed/cancelled campaign is archived (retired from active
    // views), cleared on restore. NULL = not archived. See ADR-0019.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // Single-hash-mode-per-campaign DB backstop (issue #100). Latched from
    // NULL to the first attack's `mode` at insert time (see
    // `createAttack`/`createCampaignWithAttacks` in services/campaigns.ts)
    // and never cleared. `attacks.campaignId + attacks.mode` carries a
    // composite FK against `(campaigns.id, campaigns.hashcatMode)` below, so
    // once set, every attack ever inserted for this campaign — including
    // terminal ones — must share this mode; a concurrent insert of a
    // different mode is rejected by the FK, closing the TOCTOU race the
    // app-level `checkSingleHashModePerCampaign` pre-check cannot close on
    // its own. NULL only for campaigns with no attacks yet.
    hashcatMode: integer('hashcat_mode'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('campaigns_project_id_status_idx').on(table.projectId, table.status),
    // Couple the archive markers to the lifecycle at the DB level (ADR-0019):
    // a row may only carry archived_at when it is permanent AND in a done
    // state. Closes off illegal combinations (archived draft, archived
    // non-permanent) that service logic alone could not prevent on a direct write.
    check(
      'campaigns_archive_consistency_chk',
      sql`${table.archivedAt} IS NULL OR (${table.isPermanent} = true AND ${table.status} IN ('completed', 'cancelled'))`
    ),
    // Composite-FK target for `attacks(campaign_id, mode)` below. Postgres
    // requires the referenced columns to be covered by a unique
    // constraint/index; `id` is already unique via the primary key, so this
    // index exists purely to make `(id, hashcat_mode)` satisfy that
    // requirement.
    uniqueIndex('campaigns_id_hashcat_mode_idx').on(table.id, table.hashcatMode),
  ]
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
    // ADR-0019 lifecycle markers (#106). `is_permanent` latches true on first
    // task generation and is never cleared (governs deletability). `archived_at`
    // hides a run attack from the campaign editor / scheduler, cleared on restore.
    isPermanent: boolean('is_permanent').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('attacks_campaign_id_idx').on(table.campaignId),
    // No status clause (attacks carry no persisted status, #99): an attack may be
    // archived in any derived state, but only once permanent. See ADR-0019 / #106.
    check(
      'attacks_archive_consistency_chk',
      sql`${table.archivedAt} IS NULL OR ${table.isPermanent} = true`
    ),
    // Single-hash-mode-per-campaign DB backstop (issue #100): every attack's
    // `mode` must match its campaign's latched `hashcatMode`. This is a
    // deliberate tightening beyond the app-level `checkSingleHashModePerCampaign`
    // (which only compares against non-terminal siblings, since attacks carry
    // no persisted status) — the FK has no notion of "terminal" to exempt, so
    // it enforces one mode across a campaign's entire attack history. See the
    // `campaigns.hashcatMode` comment and services/campaigns.ts for the
    // write-time latch that keeps this FK satisfiable.
    //
    // DRIFT NOTE: the migration (0035) adds `DEFERRABLE INITIALLY DEFERRED`
    // to this constraint — not expressible via drizzle-orm's `foreignKey()`
    // builder in this version, so it can't be declared here. `updateAttack`
    // (services/campaigns.ts) needs the check deferred to COMMIT: it
    // adaptively moves a campaign onto an edited attack's new mode via two
    // separate statements in one transaction (campaign latch, then attack
    // mode), and a NOT DEFERRABLE (default) FK would spuriously fail
    // between them even when they agree by commit time. If this table is
    // ever regenerated via `drizzle-kit generate`, re-add the DEFERRABLE
    // clause by hand to the emitted migration.
    foreignKey({
      name: 'attacks_campaign_id_mode_campaigns_id_hashcat_mode_fk',
      columns: [table.campaignId, table.mode],
      foreignColumns: [campaigns.id, campaigns.hashcatMode],
    }),
  ]
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
    // Task lease + committed-offset (ADR-0017, U10). `leaseExpiresAt` is extended
    // only when the keyspace watermark advances (U11); a lapsed lease makes the
    // task reclaimable inside the assignNextTask claim CTE even when Redis is
    // down. `committedKeyspaceOffset` is the BOINC-style resume cursor (U12) —
    // an ABSOLUTE keyspace coordinate (same space as workRange.start),
    // authoritative state exempt from RRD downsampling. bigint mode preserves
    // mask keyspaces beyond Number.MAX_SAFE_INTEGER. Both nullable: legacy rows
    // carry NULL lease and are swept by the demoted BullMQ backstop until they
    // cycle.
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    committedKeyspaceOffset: bigint('committed_keyspace_offset', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tasks_campaign_id_idx').on(table.campaignId),
    // U11 reclaim hot path: assignNextTask scans non-terminal leased tasks for
    // expired leases. The predicate cannot include `lease_expires_at < NOW()`
    // (NOW() is not immutable), so bound the partial index to the leasable
    // statuses and index `lease_expires_at` for the range scan.
    index('tasks_expired_lease_idx')
      .on(table.leaseExpiresAt)
      .where(sql`status IN ('assigned', 'running')`),
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

// ─── Task Telemetry ─────────────────────────────────────────────────
//
// Append-only time-series store for per-progress-report telemetry (U4).
// Plain Postgres table for now; becomes a TimescaleDB hypertable in U8
// via `create_hypertable('task_telemetry', 'time', migrate_data => true)`.
//
// CRITICAL: No `id serial primaryKey()` and no UNIQUE constraints that
// exclude `time`. TimescaleDB's create_hypertable rejects any PRIMARY KEY
// or UNIQUE that does not include the partition column — adding one here
// would block the U8 migration.
export const taskTelemetry = pgTable(
  'task_telemetry',
  {
    // Partition key / event timestamp. Defaults to `now()` so inserts
    // that omit it land at wall-clock time.
    time: timestamp('time', { withTimezone: true }).notNull().defaultNow(),
    // FK to tasks.id — ON DELETE CASCADE so telemetry is cleaned up with
    // the task row rather than left orphaned.
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    // FK to agents.id — ON DELETE SET NULL so telemetry survives agent
    // deregistration with its linkage cleared (mirrors task_events).
    agentId: integer('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    // Absolute keyspace position reported by the agent. bigint with
    // mode:'bigint' preserves precision above Number.MAX_SAFE_INTEGER
    // (mask attacks with large character classes can exceed 2^53).
    keyspaceProgress: bigint('keyspace_progress', { mode: 'bigint' }).notNull(),
    // Hash rate in hashes/second. bigint with mode:'number' mirrors
    // agentBenchmarks.speedHs; agent reports are always <= ~2^31 in
    // practice so JS number precision is fine here.
    speedHs: bigint('speed_hs', { mode: 'number' }),
    // GPU temperature in degrees Celsius. Nullable — not all agents
    // report temperature.
    temperature: real('temperature'),
  },
  (table) => [
    // Primary lookup: all telemetry for a task in chronological order.
    index('task_telemetry_task_id_time_idx').on(table.taskId, table.time.desc()),
    // Partition-friendly index for time-range queries (used by TimescaleDB
    // chunk exclusion after U8 converts this to a hypertable).
    index('task_telemetry_time_idx').on(table.time.desc()),
  ]
)

// ─── Audit Logging (#105) ───────────────────────────────────────────
// Polymorphic append-only audit table. Every state change to a resource
// writes one row. The (entity_type, entity_id) pair is a logical FK —
// no DB-level FK is declared because the target row may be deleted
// (project_id is the only real FK so per-project history queries are
// efficient even after entity deletion).
//
// actor_type / entity_type / action values are kept in sync with the
// Zod enums in `../schemas/index.ts` via the check constraints below.
// The drift-guard unit test (packages/backend/tests/unit/audit-logs-schema.test.ts)
// asserts that every Zod enum value appears in the corresponding IN-list.

/**
 * Single-row fleet-wide default agent configuration (#104). The `id = 1`
 * CHECK plus the primary key enforce the singleton invariant. "Who changed
 * it" is captured by the audit event's actor, so no `updatedBy` column is
 * needed. Hardware-bound knobs are intentionally absent — those are always
 * per-rig.
 */
export const fleetAgentConfig = pgTable(
  'fleet_agent_config',
  {
    id: integer('id').primaryKey(),
    config: jsonb('config').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('fleet_agent_config_singleton_chk', sql`${table.id} = 1`)]
)

/** Vocabulary constants re-used in the check constraints and Zod enums. */
export const AUDIT_ACTOR_TYPE_VALUES = ['user', 'agent', 'system'] as const
export const AUDIT_ENTITY_TYPE_VALUES = [
  'project',
  'campaign',
  'attack',
  'hash_list',
  'word_list',
  'rule_list',
  'mask_list',
  'agent',
  'fleet_config',
] as const
export const AUDIT_ACTION_VALUES = [
  'created',
  'updated',
  'deleted',
  'status_changed',
  'token_issued',
  'archived',
  'restored',
  'retired',
  'reclaimed',
] as const

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: serial('id').primaryKey(),
    // Who triggered the event. actorId is a bare integer (no FK) because
    // it spans both users.id and agents.id depending on actorType.
    // .$type<> is type-only branding — no DDL change; selects infer the union.
    actorType: varchar('actor_type', { length: 20 })
      .notNull()
      .$type<(typeof AUDIT_ACTOR_TYPE_VALUES)[number]>(),
    actorId: integer('actor_id'),
    // Scoping FK: set null when the project is deleted so per-project
    // history queries can still be filtered while orphan rows remain.
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'set null' }),
    // Polymorphic resource discriminator — no DB FK (entity rows can be deleted).
    // .$type<> is type-only branding — no DDL change; selects infer the union.
    entityType: varchar('entity_type', { length: 32 })
      .notNull()
      .$type<(typeof AUDIT_ENTITY_TYPE_VALUES)[number]>(),
    entityId: integer('entity_id').notNull(),
    // What happened.
    // .$type<> is type-only branding — no DDL change; selects infer the union.
    action: varchar('action', { length: 20 })
      .notNull()
      .$type<(typeof AUDIT_ACTION_VALUES)[number]>(),
    // Optional transition fields; vocabularies are caller-defined (no check).
    fromStatus: varchar('from_status', { length: 20 }),
    toStatus: varchar('to_status', { length: 20 }),
    // Human-readable reason annotation (wider than fromStatus to fit phrases).
    reason: varchar('reason', { length: 40 }),
    // Free-form before/after diff; encoding spec is owned by recordAuditEvent (U2).
    changes: jsonb('changes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Per-entity history: primary query path for the audit trail panel.
    index('audit_logs_entity_type_entity_id_created_at_idx').on(
      table.entityType,
      table.entityId,
      table.createdAt.desc()
    ),
    // Project-scoped browse: powers the dashboard audit list page (U7).
    index('audit_logs_project_id_created_at_idx').on(table.projectId, table.createdAt.desc()),
    // Retention sweep: WHERE created_at < cutoff scans without a seq-scan.
    index('audit_logs_created_at_idx').on(table.createdAt),
    // Check constraints keep DB vocabulary aligned with the Zod enums in
    // ../schemas/index.ts. The drift-guard test asserts they are identical.
    // Sync with: AUDIT_ACTOR_TYPE_VALUES / auditActorTypeSchema in ../schemas/index.ts
    check('audit_logs_actor_type_chk', sql`${table.actorType} IN ('user', 'agent', 'system')`),
    // Sync with: AUDIT_ENTITY_TYPE_VALUES / auditEntityTypeSchema in ../schemas/index.ts
    check(
      'audit_logs_entity_type_chk',
      sql`${table.entityType} IN ('project', 'campaign', 'attack', 'hash_list', 'word_list', 'rule_list', 'mask_list', 'agent', 'fleet_config')`
    ),
    // Sync with: AUDIT_ACTION_VALUES / auditActionSchema in ../schemas/index.ts
    check(
      'audit_logs_action_chk',
      sql`${table.action} IN ('created', 'updated', 'deleted', 'status_changed', 'token_issued', 'archived', 'restored', 'retired', 'reclaimed')`
    ),
  ]
)
