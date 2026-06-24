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
  hashLists,
  maskLists,
  projects,
  ruleLists,
  wordLists,
} from '@hashhive/shared'

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
    'advancedConfiguration',
    'keyspace',
    'dependencies',
    // createdAt / updatedAt excluded
  ]),

  hash_list: new Set([
    'id',
    'projectId',
    'name',
    'hashTypeId',
    'source',
    'statistics',
    'status',
    // fileRef excluded: contains storage path/URL which is operational detail
    // createdAt / updatedAt excluded
  ]),

  word_list: new Set([
    'id',
    'projectId',
    'name',
    'lineCount',
    'fileSize',
    'status',
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
    // fileRef excluded
    // createdAt / updatedAt excluded
  ]),

  agent: new Set([
    'id',
    'name',
    'projectId',
    'status',
    'capabilities',
    'crackerVersion',
    'enrollmentClientId',
    // EXCLUDED (security / operational):
    //   authToken, authTokenHash, authTokenFormat — bearer credential columns
    //   lastSeenAt — heartbeat telemetry (operational, high-frequency)
    //   hardwareProfile — hardware/OS fingerprint
    //   operatingSystemId — operational infra detail
    //   enrolledByTokenId — token issuance is audited separately via token_issued
    //   createdAt / updatedAt — system-managed
  ]),
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
 * Input to `recordAuditEvent`. The actor is resolved from the request's auth
 * context by the caller — NEVER from a request body (R5).
 */
export interface RecordAuditEventInput {
  /** Who triggered the event. Resolved from auth context, not request body. */
  actor: {
    actorType: AuditActorType
    actorId: number | null
  }
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

  const rawDiff = computeDiff(input.action, allowedOld, allowedNew)
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
  // Resource storage path/URL — operational detail, not user-meaningful metadata
  'fileRef',
  // Drizzle internal RLS marker present on every table object's key enumeration
  // (not a real column; Object.keys(table) surfaces it alongside column props)
  'enableRLS',
])
