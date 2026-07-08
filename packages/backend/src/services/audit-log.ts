/**
 * Audit event recorder (issue #105 / U2).
 *
 * `recordAuditEvent(input, executor?)` is the single chokepoint through which
 * every auditable mutation writes its trail row. It enforces two security
 * properties before computing the diff:
 *
 *   1. Per-entity ALLOWLIST (fail-closed): only columns explicitly listed for
 *      an entity type survive into `changes`. A newly added column — including
 *      a future credential column — is excluded by default until someone adds
 *      it to the allowlist. (KTD-4 / R6)
 *
 *   2. Secondary denylist: column names whose lower-case form contains any of a
 *      small set of secret fragments are dropped as a belt-and-suspenders guard,
 *      even if a future allowlist entry accidentally includes one. This runs
 *      after allowlist projection so it only touches fields that passed step 1.
 *      The fragment list is deliberately conservative; never add `hash` alone
 *      because many safe domain columns contain that word.
 *
 * Diff shape for `action: 'updated'`:
 *   `{ fieldName: { old: value, new: value }, ... }` — only fields that changed.
 *
 * For `action: 'created'`:
 *   `{ fieldName: { new: value }, ... }` — snapshot of the new row.
 *
 * For `action: 'deleted'`:
 *   `{ fieldName: { old: value }, ... }` — snapshot of the deleted row.
 *
 * For `action: 'status_changed'`:
 *   The from/to status travels in the `fromStatus`/`toStatus` columns; `changes`
 *   holds the non-status diff (may be null or a shallow change record).
 *
 * For `action: 'token_issued'`:
 *   `changes` is always null — no payload (R6).
 *
 * Errors propagate to the caller (R4): a failed audit write must fail the
 * enclosing transaction, not be silently swallowed.
 *
 * Mirror of `services/tasks/task-events.ts`: same `Executor` shape, same
 * append-only / `.returning()` semantics.
 */

import {
  type AuditAction,
  type AuditActorType,
  type AuditEntityType,
  agents,
  attacks,
  auditLogs,
  campaigns,
  fleetAgentConfig,
  hashLists,
  maskLists,
  projects,
  ruleLists,
  users,
  wordLists,
} from '@hashhive/shared'
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'

import { db } from '../db/index.js'

// ─── Size cap ───────────────────────────────────────────────────────────────

/**
 * Maximum serialized byte length for the `changes` jsonb payload.
 * Exceeding this cap truncates the diff with a `{ _truncated: true }` marker
 * so a large allowlisted jsonb column cannot inflate rows unboundedly.
 */
const CHANGES_SIZE_LIMIT_BYTES = 64 * 1024 // 64 KB

// ─── Secondary secret-fragment denylist ─────────────────────────────────────

/**
 * Column name fragments (lower-cased) that are always excluded from `changes`
 * even if a future allowlist entry inadvertently includes them.  This is a
 * belt-and-suspenders guard; the allowlist is the primary defense.
 *
 * Conservative fragment set — each entry must unambiguously identify a
 * credential-class column without colliding with safe domain names.
 * `authtokenhash`, `authtokenformat`, `secrethash`, `apikeyhash` etc. all match.
 * `password` matches `password_hash` and any future password column.
 */
const SECRET_FRAGMENTS = [
  'authtoken',
  'secrethash',
  'apikeyhash',
  'api_key_hash',
  'passwordhash',
  'password_hash',
  'password',
  'accesstoken',
  'refreshtoken',
  'idtoken',
] as const

function isSecretFieldName(key: string): boolean {
  const lower = key.toLowerCase()
  return SECRET_FRAGMENTS.some((fragment) => lower.includes(fragment))
}

// ─── Per-entity safe-column allowlists ──────────────────────────────────────
//
// Keys are camelCase Drizzle property names (same key-space as the objects
// returned by Drizzle queries — i.e. the `old` / `new` row objects passed by
// callers will have these camelCase keys).
//
// EXCLUDING from each entity:
//   - All secret/credential columns (covered by the denylist above, but excluded
//     here for defense-in-depth and clarity)
//   - Agent operational fields: authToken, authTokenHash, authTokenFormat,
//     lastSeenAt (heartbeat telemetry), hardwareProfile (fingerprint)
//   - Timestamps that are system-managed and not user-modifiable: createdAt,
//     updatedAt — these are excluded because they change on every write and
//     would flood diffs with noise; explicit lifecycle timestamps like
//     startedAt / completedAt / archivedAt are INCLUDED because they
//     communicate meaningful state to operators.
//   - Internal FK ids that don't represent user decisions: operatingSystemId,
//     enrolledByTokenId (operational; enrollment is audited via token_issued)
//
// DRIFT GUARD: a unit test asserts every column on each audited table is
// present on either its allowlist or the secret/operational denylist so a new
// column forces an explicit decision rather than silent inclusion or exclusion.

/**
 * Set of camelCase Drizzle column property names safe to include in audit diffs.
 * Any column absent from its entity's allowlist is silently dropped before the
 * diff is computed — this is the fail-closed guarantee (KTD-4).
 */
export const ENTITY_ALLOWLISTS: Record<AuditEntityType, ReadonlySet<string>> = {
  project: new Set([
    'id',
    'name',
    'description',
    'slug',
    'settings',
    'createdBy',
    // Synthetic keys used only by membership-change audit rows (never present
    // on real project rows). They let addUserToProject / removeUserFromProject /
    // updateMemberRoles capture the old→new role diff without polluting the
    // project CRUD diff (these keys are absent from all real project rows so
    // they only appear in the diff when explicitly supplied by the caller).
    'memberUserId',
    'memberRoles',
    // createdAt / updatedAt excluded: system-managed noise
  ]),

  campaign: new Set([
    'id',
    'projectId',
    'name',
    'description',
    'hashListId',
    'status',
    'isPermanent',
    'priority',
    'progress',
    'metadata',
    'createdBy',
    'startedAt',
    'completedAt',
    'archivedAt',
    // Single-hash-mode-per-campaign DB backstop (issue #100): latched from
    // NULL to the first attack's mode; worth auditing like `attack.mode`.
    'hashcatMode',
    // createdAt / updatedAt excluded
  ]),

  attack: new Set([
    'id',
    'campaignId',
    'projectId',
    'mode',
    'hashTypeId',
    'wordlistId',
    'rulelistId',
    'masklistId',
    'keyspace',
    'dependencies',
    'isPermanent',
    'archivedAt',
    // EXCLUDED:
    //   advancedConfiguration — user-controlled passthrough hashcat blob
    //     (z.record(z.string(), z.unknown())); storing it verbatim in audit
    //     changes exposes an unbounded jsonb write channel.
    //   createdAt / updatedAt — system-managed noise
  ]),

  hash_list: new Set([
    'id',
    'projectId',
    'name',
    'hashTypeId',
    'source',
    'statistics',
    'status',
    'isPermanent',
    'archivedAt',
    // fileRef excluded: contains storage path/URL which is operational detail
    // createdAt / updatedAt excluded
    // Synthetic key used only by import audit rows — never present on real
    // hash_list rows. Lets recordImportAudit embed a stagingKey dedup token
    // in changes so retry runs can detect a previously-written audit row.
    'importKey',
  ]),

  word_list: new Set([
    'id',
    'projectId',
    'name',
    'lineCount',
    'fileSize',
    'status',
    'isPermanent',
    'archivedAt',
    'blobReclaimedAt',
    'fileChecksum',
    // fileRef excluded
    // createdAt / updatedAt excluded
  ]),

  rule_list: new Set([
    'id',
    'projectId',
    'name',
    'lineCount',
    'fileSize',
    'status',
    'isPermanent',
    'archivedAt',
    'blobReclaimedAt',
    'fileChecksum',
    // fileRef excluded
    // createdAt / updatedAt excluded
  ]),

  mask_list: new Set([
    'id',
    'projectId',
    'name',
    'lineCount',
    'fileSize',
    'keyspace',
    'status',
    'isPermanent',
    'archivedAt',
    'blobReclaimedAt',
    'fileChecksum',
    // fileRef excluded
    // createdAt / updatedAt excluded
  ]),

  agent: new Set([
    'id',
    'name',
    'projectId',
    'status',
    'crackerVersion',
    'enrollmentClientId',
    // Per-rig advanced config (#104) — operator-meaningful, audited on edit.
    'config',
    // EXCLUDED (security / operational):
    //   capabilities — agent-controlled free-form jsonb (set by the agent at
    //     enrollment via the anonymous enrollment path); storing it verbatim
    //     in the audit trail creates an injection/exfil channel through the
    //     admin-readable changes column.
    //   authToken, authTokenHash, authTokenFormat — bearer credential columns
    //   lastSeenAt — heartbeat telemetry (operational, high-frequency)
    //   hardwareProfile — hardware/OS fingerprint
    //   operatingSystemId — operational infra detail
    //   enrolledByTokenId — token issuance is audited separately via token_issued
    //   createdAt / updatedAt — system-managed
  ]),
  // Fleet-wide default agent config (#104). Singleton row; `config` is the
  // only operator-meaningful column. `updatedAt` is system-managed (excluded
  // globally) and "who" is captured by the audit event's actor.
  fleet_config: new Set(['id', 'config']),
}

// ─── Executor type ───────────────────────────────────────────────────────────

/**
 * Minimal db surface required by `recordAuditEvent`. Both the module-level
 * `db` and a Drizzle transaction handle satisfy this type, so callers inside
 * a transaction pass their `tx` to keep the audit row atomic with the mutation.
 */
type Executor = Pick<typeof db, 'insert'>

// ─── Input type ──────────────────────────────────────────────────────────────

/**
 * Discriminated union for the actor field of `RecordAuditEventInput`.
 * Enforces that system actors always have `actorId: null` and user/agent
 * actors always carry a numeric id. Route handlers can import this type
 * directly to avoid re-declaring local actor shapes.
 */
export type AuditActor =
  | { actorType: 'user'; actorId: number }
  | { actorType: 'agent'; actorId: number }
  | { actorType: 'system'; actorId: null }

/**
 * Input to `recordAuditEvent`. The actor is resolved from the request's auth
 * context by the caller — NEVER from a request body (R5).
 */
export interface RecordAuditEventInput {
  /** Who triggered the event. Resolved from auth context, not request body. */
  actor: AuditActor
  /** Project the event belongs to. Used for scoped browsing. */
  projectId: number | null
  /** The kind of entity that was modified. */
  entityType: AuditEntityType
  /** The integer PK of the modified entity. */
  entityId: number
  /** The operation that was performed. */
  action: AuditAction
  /** For status_changed: the previous status value. */
  fromStatus?: string | null
  /** For status_changed: the next status value. */
  toStatus?: string | null
  /** Optional human-readable reason annotation. */
  reason?: string | null
  /**
   * The entity row before the mutation. Used for `deleted` and `updated`
   * actions. Pass `null` for `created`.
   */
  oldRow?: Record<string, unknown> | null
  /**
   * The entity row after the mutation. Used for `created` and `updated`
   * actions. Pass `null` for `deleted`.
   */
  newRow?: Record<string, unknown> | null
}

// ─── Allowlist projection ────────────────────────────────────────────────────

/**
 * Projects a raw row down to only the columns on the entity's allowlist,
 * then applies the secondary secret-fragment denylist as a backstop.
 * Returns a new plain object — never mutates the input.
 */
function projectRow(
  row: Record<string, unknown>,
  entityType: AuditEntityType
): Record<string, unknown> {
  const allowed = ENTITY_ALLOWLISTS[entityType]
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (allowed.has(key) && !isSecretFieldName(key)) {
      result[key] = value
    }
  }
  return result
}

// ─── Diff computation ────────────────────────────────────────────────────────

type ChangedField = { old?: unknown; new?: unknown }
type DiffRecord = Record<string, ChangedField>

/**
 * Computes a shallow diff between two (already-projected) row objects.
 *
 * - For `created`: returns `{ field: { new: value } }` for each field in newRow.
 * - For `deleted`: returns `{ field: { old: value } }` for each field in oldRow.
 * - For `updated` / `status_changed`: returns `{ field: { old, new } }` for
 *   fields whose values differ. Equality is by `JSON.stringify` so jsonb columns
 *   (objects/arrays) are compared by value, not reference.
 * - For `token_issued`: always returns `null`.
 */
function computeDiff(
  action: AuditAction,
  oldProjected: Record<string, unknown> | null,
  newProjected: Record<string, unknown> | null
): DiffRecord | null {
  if (action === 'token_issued') return null

  if (action === 'created') {
    if (!newProjected) return null
    const diff: DiffRecord = {}
    for (const [key, value] of Object.entries(newProjected)) {
      diff[key] = { new: value }
    }
    return diff
  }

  if (action === 'deleted') {
    if (!oldProjected) return null
    const diff: DiffRecord = {}
    for (const [key, value] of Object.entries(oldProjected)) {
      diff[key] = { old: value }
    }
    return diff
  }

  // updated / status_changed: shallow diff of changed fields only
  const diff: DiffRecord = {}
  const allKeys = new Set([...Object.keys(oldProjected ?? {}), ...Object.keys(newProjected ?? {})])

  for (const key of allKeys) {
    const oldVal = oldProjected?.[key]
    const newVal = newProjected?.[key]
    // JSON.stringify equality handles jsonb column comparison by value
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diff[key] = { old: oldVal, new: newVal }
    }
  }

  return Object.keys(diff).length > 0 ? diff : null
}

// ─── Size cap enforcement ────────────────────────────────────────────────────

/**
 * Enforces the 64 KB payload cap. If the serialized diff exceeds
 * `CHANGES_SIZE_LIMIT_BYTES`, returns a truncation marker instead of the
 * full payload. Uses `Buffer.byteLength` for accurate byte counting
 * (char count ≠ byte count for non-ASCII values).
 */
function capChanges(changes: DiffRecord | null): Record<string, unknown> | null {
  if (!changes) return null
  const serialized = JSON.stringify(changes)
  if (Buffer.byteLength(serialized, 'utf8') > CHANGES_SIZE_LIMIT_BYTES) {
    return { _truncated: true }
  }
  return changes as Record<string, unknown>
}

// ─── Public recorder ─────────────────────────────────────────────────────────

/**
 * Persists one audit row. Returns the inserted row.
 *
 * Pass the active transaction as `executor` to commit the audit row atomically
 * with the mutation write. Defaults to the module `db` for standalone use.
 *
 * Errors propagate — a failed insert is a real failure (R4). Never catch
 * errors here; the caller's transaction must roll back if the audit write fails.
 */
export async function recordAuditEvent(input: RecordAuditEventInput, executor: Executor = db) {
  const allowedOld = input.oldRow ? projectRow(input.oldRow, input.entityType) : null
  const allowedNew = input.newRow ? projectRow(input.newRow, input.entityType) : null

  // status_changed: the from/to status travels in the dedicated fromStatus/toStatus
  // columns. Strip 'status' from the projected rows before diffing so it does not
  // also appear redundantly inside `changes`.
  const diffOld =
    input.action === 'status_changed' && allowedOld
      ? Object.fromEntries(Object.entries(allowedOld).filter(([k]) => k !== 'status'))
      : allowedOld
  const diffNew =
    input.action === 'status_changed' && allowedNew
      ? Object.fromEntries(Object.entries(allowedNew).filter(([k]) => k !== 'status'))
      : allowedNew

  const rawDiff = computeDiff(input.action, diffOld, diffNew)
  const changes = capChanges(rawDiff)

  const [row] = await executor
    .insert(auditLogs)
    .values({
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      projectId: input.projectId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      reason: input.reason ?? null,
      changes,
    })
    .returning()

  return row
}

// ─── Read service (shared by U7 dashboard + U8 control) ─────────────────────

/**
 * Filters accepted by `listAuditEvents`. All fields are truly optional —
 * omitting a field means "no filter applied" for that dimension.
 */
export interface AuditLogFilters {
  entityType?: AuditEntityType | undefined
  entityId?: number | undefined
  actorType?: AuditActorType | undefined
  action?: AuditAction | undefined
  dateFrom?: string | undefined
  dateTo?: string | undefined
}

/**
 * Pagination params for `listAuditEvents`.
 */
export interface AuditLogPagination {
  limit: number
  offset: number
}

/**
 * Single audit log row with resolved display labels.
 * Matches the `auditLogSchema` wire shape so callers can parse through it.
 */
export interface AuditLogRow {
  id: number
  actorType: AuditActorType
  actorId: number | null
  projectId: number | null
  entityType: AuditEntityType
  entityId: number
  action: AuditAction
  fromStatus: string | null
  toStatus: string | null
  reason: string | null
  changes: Record<string, unknown> | null
  createdAt: string
  actorLabel: string
  entityLabel: string
}

/**
 * Response shape returned by `listAuditEvents`.
 * Matches `auditLogListResponseSchema` exactly.
 */
export interface AuditLogListResult {
  data: AuditLogRow[]
  total: number
  limit: number
  offset: number
}

// ─── Label resolution helpers ────────────────────────────────────────────────

/**
 * Batch-loads user display names for a set of user ids.
 * Returns a map from id → name (never email).
 * Missing ids produce '[deleted user]'.
 */
async function batchLoadUserNames(ids: Set<number>): Promise<Map<number, string>> {
  if (ids.size === 0) return new Map()
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, [...ids]))
  const map = new Map<number, string>()
  for (const row of rows) {
    map.set(row.id, row.name)
  }
  return map
}

/**
 * Batch-loads agent names for a set of agent ids.
 * Returns a map from id → name.
 * Missing ids produce '[deleted agent]'.
 */
async function batchLoadAgentNames(ids: Set<number>): Promise<Map<number, string>> {
  if (ids.size === 0) return new Map()
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(inArray(agents.id, [...ids]))
  const map = new Map<number, string>()
  for (const row of rows) {
    map.set(row.id, row.name)
  }
  return map
}

type EntityBatchResult = Map<number, string>

/**
 * Batch-loads entity display names for a set of (entityType, ids) pairs.
 * Returns a map from entityId → label string.
 *
 * Entity name resolution per type:
 *   project    → projects.name
 *   campaign   → campaigns.name
 *   attack     → 'Attack #<id>' (no name column on attacks)
 *   hash_list  → hashLists.name
 *   word_list  → wordLists.name
 *   rule_list  → ruleLists.name
 *   mask_list  → maskLists.name
 *   agent      → agents.name
 *
 * Missing ids produce '[deleted]'.
 */
async function batchLoadEntityNames(
  entityType: string,
  ids: Set<number>
): Promise<EntityBatchResult> {
  if (ids.size === 0) return new Map()
  const idList = [...ids]

  switch (entityType) {
    case 'project': {
      const rows = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, idList))
      return new Map(rows.map((r) => [r.id, r.name]))
    }
    case 'campaign': {
      const rows = await db
        .select({ id: campaigns.id, name: campaigns.name })
        .from(campaigns)
        .where(inArray(campaigns.id, idList))
      return new Map(rows.map((r) => [r.id, r.name]))
    }
    case 'attack': {
      // attacks have no name column; use a synthetic label
      const map = new Map<number, string>()
      for (const id of idList) {
        map.set(id, `Attack #${id}`)
      }
      return map
    }
    case 'hash_list': {
      const rows = await db
        .select({ id: hashLists.id, name: hashLists.name })
        .from(hashLists)
        .where(inArray(hashLists.id, idList))
      return new Map(rows.map((r) => [r.id, r.name]))
    }
    case 'word_list': {
      const rows = await db
        .select({ id: wordLists.id, name: wordLists.name })
        .from(wordLists)
        .where(inArray(wordLists.id, idList))
      return new Map(rows.map((r) => [r.id, r.name]))
    }
    case 'rule_list': {
      const rows = await db
        .select({ id: ruleLists.id, name: ruleLists.name })
        .from(ruleLists)
        .where(inArray(ruleLists.id, idList))
      return new Map(rows.map((r) => [r.id, r.name]))
    }
    case 'mask_list': {
      const rows = await db
        .select({ id: maskLists.id, name: maskLists.name })
        .from(maskLists)
        .where(inArray(maskLists.id, idList))
      return new Map(rows.map((r) => [r.id, r.name]))
    }
    case 'agent': {
      const rows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, idList))
      return new Map(rows.map((r) => [r.id, r.name]))
    }
    default: {
      // Unknown entity type — return empty map; all rows fall back to '[deleted]'
      return new Map()
    }
  }
}

// ─── Public read service ──────────────────────────────────────────────────────

/**
 * Returns a paginated, filtered page of audit log rows scoped to `projectId`,
 * ordered newest-first (`created_at DESC`), with resolved `actorLabel` and
 * `entityLabel` display strings.
 *
 * Label resolution uses batched follow-up lookups (one batch per actor type,
 * one batch per entity type) rather than per-row N+1 or one wide multi-table
 * join. Missing referents fall back gracefully:
 *   - user actor  → display name or '[deleted user]'
 *   - agent actor → agent name or '[deleted agent]'
 *   - system      → 'System'
 *   - entity      → entity name or '[deleted]'
 *
 * `actorLabel` is NEVER the user's email (R6 / KTD-8).
 */
export async function listAuditEvents(
  projectId: number,
  filters: AuditLogFilters,
  pagination: AuditLogPagination
): Promise<AuditLogListResult> {
  const { limit, offset } = pagination

  // Build WHERE conditions
  const conditions: ReturnType<typeof eq>[] = [eq(auditLogs.projectId, projectId)]

  if (filters.entityType) {
    conditions.push(eq(auditLogs.entityType, filters.entityType))
  }
  if (filters.entityId !== undefined) {
    conditions.push(eq(auditLogs.entityId, filters.entityId))
  }
  if (filters.actorType) {
    conditions.push(eq(auditLogs.actorType, filters.actorType))
  }
  if (filters.action) {
    conditions.push(eq(auditLogs.action, filters.action))
  }
  if (filters.dateFrom) {
    conditions.push(gte(auditLogs.createdAt, new Date(filters.dateFrom)))
  }
  if (filters.dateTo) {
    conditions.push(lte(auditLogs.createdAt, new Date(filters.dateTo)))
  }

  const whereClause = and(...conditions)

  // Fetch the page and total count in parallel
  const [rawRows, countResult] = await Promise.all([
    db
      .select()
      .from(auditLogs)
      .where(whereClause)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(auditLogs)
      .where(whereClause),
  ])

  const total = Number(countResult[0]?.count ?? 0)

  if (rawRows.length === 0) {
    return { data: [], total, limit, offset }
  }

  // Collect actor ids by type for batched resolution
  const userActorIds = new Set<number>()
  const agentActorIds = new Set<number>()
  for (const row of rawRows) {
    if (row.actorType === 'user' && row.actorId !== null) {
      userActorIds.add(row.actorId)
    } else if (row.actorType === 'agent' && row.actorId !== null) {
      agentActorIds.add(row.actorId)
    }
  }

  // Collect entity ids by type for batched resolution
  const entityIdsByType = new Map<string, Set<number>>()
  for (const row of rawRows) {
    const existing = entityIdsByType.get(row.entityType)
    if (existing) {
      existing.add(row.entityId)
    } else {
      entityIdsByType.set(row.entityType, new Set([row.entityId]))
    }
  }

  // safeLoad: wraps a batch-load so a transient DB error yields an empty Map
  // rather than rejecting the whole Promise.all. The per-row mapper already
  // null-coalesces missing entries to '[deleted ...]' fallbacks (R4 resilience).
  async function safeLoad<K, V>(fn: () => Promise<Map<K, V>>): Promise<Map<K, V>> {
    try {
      return await fn()
    } catch {
      return new Map<K, V>()
    }
  }

  // Batch load all names in parallel
  const entityNamePromises = [...entityIdsByType.entries()].map(
    async ([type, ids]) => [type, await safeLoad(() => batchLoadEntityNames(type, ids))] as const
  )

  const [userNames, agentNames, ...entityNameResults] = await Promise.all([
    safeLoad(() => batchLoadUserNames(userActorIds)),
    safeLoad(() => batchLoadAgentNames(agentActorIds)),
    ...entityNamePromises,
  ])

  const entityNamesByType = new Map<string, EntityBatchResult>(entityNameResults)

  // Map rows to wire shape with resolved labels
  const data: AuditLogRow[] = rawRows.map((row) => {
    // Resolve actorLabel — never use email (R6 / KTD-8)
    let actorLabel: string
    if (row.actorType === 'user') {
      actorLabel =
        row.actorId !== null ? (userNames.get(row.actorId) ?? '[deleted user]') : '[deleted user]'
    } else if (row.actorType === 'agent') {
      actorLabel =
        row.actorId !== null
          ? (agentNames.get(row.actorId) ?? '[deleted agent]')
          : '[deleted agent]'
    } else {
      // 'system'
      actorLabel = 'System'
    }

    // Resolve entityLabel
    const entityMap = entityNamesByType.get(row.entityType)
    const entityLabel = entityMap?.get(row.entityId) ?? '[deleted]'

    return {
      id: row.id,
      actorType: row.actorType as AuditActorType,
      actorId: row.actorId,
      projectId: row.projectId,
      entityType: row.entityType as AuditEntityType,
      entityId: row.entityId,
      action: row.action as AuditAction,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      reason: row.reason,
      changes: row.changes as Record<string, unknown> | null,
      createdAt: row.createdAt.toISOString(),
      actorLabel,
      entityLabel,
    }
  })

  return { data, total, limit, offset }
}

// ─── Drift guard helpers (exported for the unit test) ───────────────────────

/**
 * Returns the camelCase Drizzle column property names for each audited table.
 * Used by the drift-guard test to assert every column is explicitly accounted
 * for (either on the allowlist or on the secret/operational exclusion list).
 */
export const AUDITED_TABLE_COLUMNS: Record<AuditEntityType, ReadonlySet<string>> = {
  project: new Set(Object.keys(projects)),
  campaign: new Set(Object.keys(campaigns)),
  attack: new Set(Object.keys(attacks)),
  hash_list: new Set(Object.keys(hashLists)),
  word_list: new Set(Object.keys(wordLists)),
  rule_list: new Set(Object.keys(ruleLists)),
  mask_list: new Set(Object.keys(maskLists)),
  agent: new Set(Object.keys(agents)),
  fleet_config: new Set(Object.keys(fleetAgentConfig)),
}

/**
 * Columns explicitly excluded from every entity's allowlist for security or
 * operational reasons. The drift-guard test asserts that for each table:
 *
 *   allowlist(entityType) ∪ EXPLICITLY_EXCLUDED_COLUMNS ⊇ all table columns
 *
 * so every column is accounted for and none falls through the gap silently.
 */
export const EXPLICITLY_EXCLUDED_COLUMNS: ReadonlySet<string> = new Set([
  // System-managed timestamps (noise on every write)
  'createdAt',
  'updatedAt',
  // Agent auth/credential columns (R6)
  'authToken',
  'authTokenHash',
  'authTokenFormat',
  // Agent operational fields (high-frequency / fingerprint)
  'lastSeenAt',
  'hardwareProfile',
  'operatingSystemId',
  // Enrollment binding (audited via token_issued event, not a diff field)
  'enrolledByTokenId',
  // Agent-controlled free-form jsonb (injection/exfil risk via enrollment path)
  'capabilities',
  // User-controlled passthrough hashcat blob (unbounded jsonb write channel)
  'advancedConfiguration',
  // Resource storage path/URL — operational detail, not user-meaningful metadata
  'fileRef',
  // Drizzle internal RLS marker present on every table object's key enumeration
  // (not a real column; Object.keys(table) surfaces it alongside column props)
  'enableRLS',
])
