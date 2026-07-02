import type {
  AgentCurrentTask,
  AgentHeartbeat,
  AgentHeartbeatError,
  AgentWorstSeverity,
  SelectAgentBenchmark,
} from '@hashhive/shared'

import { agentBenchmarks, agentErrors, agents, attacks, campaigns, tasks } from '@hashhive/shared'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'

import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { REVIEW_RECOMMENDED_THRESHOLD, WHITELISTED_SEVERITY } from './agents/whitelist.js'
import { type RecordAuditEventInput, recordAuditEvent } from './audit-log.js'
import { emitAgentStatus, emitAgentError } from './events.js'

// ─── Actor type ──────────────────────────────────────────────────────────────

/**
 * Who is performing an auditable mutation. Resolved from the request's auth
 * context by the route handler and threaded into service functions — never
 * derived from the request body (R5).
 */
export type Actor = RecordAuditEventInput['actor']

// SelectAgent from @hashhive/shared is the zod-strict shape (jsonb as Json),
// but Drizzle's row selection narrows jsonb to `unknown`. Deriving from
// getAgentById's return shape keeps AgentListRow assignable from the raw row
// without bouncing through a Json cast.
type SelectedAgent = NonNullable<Awaited<ReturnType<typeof getAgentById>>>

export type AgentListRow = SelectedAgent & {
  errorCount24h: number
  worstSeverity24h: AgentWorstSeverity
  currentTask: AgentCurrentTask | null
  /** True when the agent's whitelisted-error count in the 24h window meets
   * or exceeds REVIEW_RECOMMENDED_THRESHOLD. Distinct from `error` status —
   * a healthy agent can have reviewRecommended=true if its whitelist is
   * absorbing too many errors (R18). */
  reviewRecommended: boolean
}

// currentTask on the list response only shows tasks the agent is actively
// executing — pending tasks (queued for an agent but not yet started) are not
// surfaced here. The detail page's listTasksByAgent intentionally includes
// 'pending' (see AGENT_TASK_ACTIVE_STATUSES in services/tasks.ts) so operators
// can see the full queue for one agent.
const ACTIVE_TASK_STATUSES = ['assigned', 'running'] as const

// Severity policy for the 24h error badge.
// `info`/`debug`/`notice` and other unknown severities intentionally do not
// contribute to the count or the badge color — the SQL `count(*) FILTER`
// applies the same allowlist, so the two layers can't drift.
export const FATAL_SEVERITIES = ['fatal', 'critical', 'error']
export const WARNING_SEVERITIES = ['warning']

/**
 * Classify a severity-allowlist hit pair into the three-state badge.
 * Pure function exported so the policy is unit-testable without touching
 * the database.
 */
export function classifyWorstSeverity(opts: {
  hasFatal: boolean
  hasWarning: boolean
}): AgentWorstSeverity {
  if (opts.hasFatal) return 'fatal'
  if (opts.hasWarning) return 'warning'
  return null
}

/**
 * Test-only helper: classify a buffered set of severity rows the same way
 * the SQL aggregate does. Mirrors the FILTER/bool_or behavior in
 * aggregateRecentErrors so tests can pin the policy without a database.
 */
export function classifyRecentErrors(rows: { severity: string }[]): {
  count: number
  worstSeverity: AgentWorstSeverity
} {
  let hasFatal = false
  let hasWarning = false
  let count = 0
  for (const row of rows) {
    const lower = row.severity.toLowerCase()
    const isFatal = FATAL_SEVERITIES.includes(lower)
    const isWarning = WARNING_SEVERITIES.includes(lower)
    if (isFatal || isWarning) count += 1
    if (isFatal) hasFatal = true
    if (isWarning) hasWarning = true
  }
  return {
    count,
    worstSeverity: classifyWorstSeverity({ hasFatal, hasWarning }),
  }
}

interface ActiveTaskRow {
  taskId: number
  status: string
  campaignId: number
  campaignName: string
  attackId: number
  attackMode: number
  startedAt?: Date | string | null | undefined
  assignedAt?: Date | string | null | undefined
}

/**
 * Selects one task per agent from a pre-sorted list of active tasks,
 * preferring 'running' over 'assigned' and then the most recently
 * started/assigned. Pure so the ordering policy is unit-testable.
 */
export function pickCurrentTaskByAgent(
  rows: (ActiveTaskRow & { agentId: number | null })[]
): Map<number, AgentCurrentTask> {
  const ts = (v: Date | string | null | undefined): number => {
    if (!v) return 0
    if (v instanceof Date) return v.getTime()
    const t = new Date(v).getTime()
    return Number.isFinite(t) ? t : 0
  }
  const sorted = [...rows]
    .filter((r): r is ActiveTaskRow & { agentId: number } => r.agentId !== null)
    .sort((a, b) => {
      const statusRank = (s: string) => (s === 'running' ? 0 : 1)
      const byStatus = statusRank(a.status) - statusRank(b.status)
      if (byStatus !== 0) return byStatus
      const byStarted = ts(b.startedAt) - ts(a.startedAt)
      if (byStarted !== 0) return byStarted
      return ts(b.assignedAt) - ts(a.assignedAt)
    })
  const map = new Map<number, AgentCurrentTask>()
  for (const row of sorted) {
    if (map.has(row.agentId)) continue
    map.set(row.agentId, {
      id: row.taskId,
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      attackId: row.attackId,
      attackMode: row.attackMode,
      status: row.status,
    })
  }
  return map
}

export async function getAgentById(agentId: number) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
  return agent ?? null
}

export async function listAgents(filters: {
  projectId?: number | undefined
  status?: string | undefined
  limit?: number | undefined
  offset?: number | undefined
}): Promise<{
  agents: AgentListRow[]
  total: number
  limit: number
  offset: number
}> {
  let query = db.select().from(agents).$dynamic()

  const conditions = []
  if (filters.projectId) {
    conditions.push(eq(agents.projectId, filters.projectId))
  }
  if (filters.status) {
    conditions.push(eq(agents.status, filters.status))
  } else {
    // Default active-fleet view excludes retired agents (R7/R10, issue
    // #106 U8) — a decommissioned agent should not clutter the fleet list
    // an operator sees by default. An explicit `status=retired` filter
    // still reaches them (the branch above), which doubles as the
    // "explicit filter to reveal them" escape hatch R10 asks for, mirroring
    // the `showArchived` pattern used by resources/attacks without adding
    // a second query param for a status the `status` filter already covers.
    conditions.push(ne(agents.status, 'retired'))
  }
  if (conditions.length > 0) {
    query = query.where(and(...conditions))
  }

  const limit = filters.limit ?? 50
  const offset = filters.offset ?? 0

  const [results, countResult] = await Promise.all([
    query.limit(limit).offset(offset).orderBy(desc(agents.lastSeenAt)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(agents)
      .where(conditions.length > 0 ? and(...conditions) : undefined),
  ])

  const agentIds = results.map((a) => a.id)
  const [errorAggregates, currentTasks] = await Promise.all([
    aggregateRecentErrors(agentIds),
    fetchCurrentTasks(agentIds),
  ])

  const enriched: AgentListRow[] = results.map((agent) => {
    const agg = errorAggregates.get(agent.id)
    return {
      ...agent,
      errorCount24h: agg?.count ?? 0,
      worstSeverity24h: agg?.worstSeverity ?? null,
      currentTask: currentTasks.get(agent.id) ?? null,
      reviewRecommended: (agg?.whitelistedCount ?? 0) >= REVIEW_RECOMMENDED_THRESHOLD,
    }
  })

  return {
    agents: enriched,
    total: Number(countResult[0]?.count ?? 0),
    limit,
    offset,
  }
}

async function aggregateRecentErrors(agentIds: number[]): Promise<
  Map<
    number,
    {
      count: number
      worstSeverity: AgentWorstSeverity
      whitelistedCount: number
    }
  >
> {
  const map = new Map<
    number,
    {
      count: number
      worstSeverity: AgentWorstSeverity
      whitelistedCount: number
    }
  >()
  if (agentIds.length === 0) {
    return map
  }

  // Server-side aggregation: bounded wire size at one row per agent, regardless
  // of how many errors a noisy agent emits. Unknown severities (info/debug/...)
  // are excluded from `count` and from the `hasWarning` / `hasFatal` flags.
  // Whitelisted rows are counted separately via the `context.whitelisted` JSON
  // marker written by `downgradeIfWhitelisted` at ingest time (R18).
  const fatalArray = sql`ARRAY[${sql.raw(FATAL_SEVERITIES.map((s) => `'${s}'`).join(','))}]::text[]`
  const warningArray = sql`ARRAY[${sql.raw(WARNING_SEVERITIES.map((s) => `'${s}'`).join(','))}]::text[]`
  const whitelistedSeverity = sql.raw(`'${WHITELISTED_SEVERITY}'`)

  const rows = await db
    .select({
      agentId: agentErrors.agentId,
      count: sql<number>`count(*) FILTER (WHERE lower(${agentErrors.severity}) = ANY(${fatalArray}) OR lower(${agentErrors.severity}) = ANY(${warningArray}))`,
      hasFatal: sql<boolean>`bool_or(lower(${agentErrors.severity}) = ANY(${fatalArray}))`,
      hasWarning: sql<boolean>`bool_or(lower(${agentErrors.severity}) = ANY(${warningArray}))`,
      whitelistedCount: sql<number>`count(*) FILTER (WHERE lower(${agentErrors.severity}) = ${whitelistedSeverity} AND (${agentErrors.context}->>'whitelisted')::boolean IS TRUE)`,
    })
    .from(agentErrors)
    .where(
      and(
        inArray(agentErrors.agentId, agentIds),
        sql`${agentErrors.createdAt} >= now() - interval '24 hours'`
      )
    )
    .groupBy(agentErrors.agentId)

  for (const row of rows) {
    const count = Number(row.count ?? 0)
    const whitelistedCount = Number(row.whitelistedCount ?? 0)
    if (count === 0 && whitelistedCount === 0) continue
    map.set(row.agentId, {
      count,
      worstSeverity: classifyWorstSeverity({
        hasFatal: Boolean(row.hasFatal),
        hasWarning: Boolean(row.hasWarning),
      }),
      whitelistedCount,
    })
  }

  return map
}

async function fetchCurrentTasks(
  agentIds: number[]
): Promise<Map<number, AgentListRow['currentTask']>> {
  const map = new Map<number, AgentListRow['currentTask']>()
  if (agentIds.length === 0) {
    return map
  }

  const rows = await db
    .select({
      taskId: tasks.id,
      agentId: tasks.agentId,
      status: tasks.status,
      campaignId: campaigns.id,
      campaignName: campaigns.name,
      attackId: attacks.id,
      attackMode: attacks.mode,
      startedAt: tasks.startedAt,
      assignedAt: tasks.assignedAt,
    })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .innerJoin(attacks, eq(tasks.attackId, attacks.id))
    .where(and(inArray(tasks.agentId, agentIds), inArray(tasks.status, [...ACTIVE_TASK_STATUSES])))
    // Push the deterministic ordering — running before assigned, most
    // recently started/assigned first — to the database. The helper
    // pickCurrentTaskByAgent re-applies the same policy so unit tests
    // can pin it without a DB.
    .orderBy(
      sql`CASE WHEN ${tasks.status} = 'running' THEN 0 ELSE 1 END`,
      desc(tasks.startedAt),
      desc(tasks.assignedAt)
    )

  const selected = pickCurrentTaskByAgent(rows)
  for (const [agentId, task] of selected) {
    map.set(agentId, task)
  }

  return map
}

/**
 * Reason carried on the structured status-transition log line. Kept as a
 * narrow literal union so a typo at a call site is a type error, and so
 * downstream log queries have a stable enum to filter on.
 *
 * - `'fatal_error'`: heartbeat reported `error.severity='fatal'`; status
 *   forced to `'error'`.
 * - `'heartbeat_status'`: heartbeat carried a non-fatal status literal
 *   different from the agent's current row (e.g., `'offline' -> 'online'`
 *   when the agent comes back from the heartbeat-monitor sweep).
 */
export type StatusTransitionReason = 'fatal_error' | 'heartbeat_status'

// Anchored to `AgentHeartbeat['status']` so the service layer cannot
// drift from the zod boundary.
type HeartbeatStatusLiteral = AgentHeartbeat['status']
// 'retired' is added for the terminal-status guard below: a retired
// agent's heartbeat resolves to effectiveStatus 'retired' (never the
// payload status), even though agents never self-report 'retired' in a
// heartbeat payload (HeartbeatStatusLiteral doesn't include it).
type ResolvedStatusLiteral = HeartbeatStatusLiteral | 'error' | 'retired'

/**
 * Discriminated union: a heartbeat either resolves to a no-op transition
 * (status unchanged) or a real transition that needs an audit-log line.
 * Using a `kind` discriminant forces call sites to handle both arms and
 * makes `fromStatus` / `reason` available only when they're meaningful.
 */
export type HeartbeatTransition =
  | {
      kind: 'noop'
      effectiveStatus: ResolvedStatusLiteral
      isFatalError: boolean
    }
  | {
      kind: 'transition'
      effectiveStatus: ResolvedStatusLiteral
      isFatalError: boolean
      reason: StatusTransitionReason
      fromStatus: string
    }

/**
 * Pure decision: given the payload status, optional error severity, and
 * the agent's current persisted status, decide the effective status the
 * row will be updated to, whether the heartbeat is a fatal-error path,
 * and whether a status-transition audit log line should fire.
 *
 * Exported so the policy can be pinned by unit tests without a database
 * (mirrors the `classifyWorstSeverity` pattern). The DB-bound caller in
 * `processHeartbeat` is just the wiring around this decision.
 */
export function decideHeartbeatTransition(input: {
  payloadStatus: HeartbeatStatusLiteral
  errorSeverity?: AgentHeartbeatError['severity'] | undefined
  priorStatus: string | null
}): HeartbeatTransition {
  // Terminal-status guard (issue #106 U8, R8/R9): once an agent is
  // retired, no heartbeat can un-retire it. A still-running rig that
  // hasn't been told to stop keeps polling with `status: 'online'`; without
  // this guard `priorStatus !== effectiveStatus` below would be true, the
  // transition would flip the row back to 'online', and the agent would
  // become claim-eligible again (`computeHighPriorityHint` / the agent
  // task-claim endpoint both gate on `agents.status`). Checked before the
  // fatal-error override too, so a fatal-severity heartbeat from a retired
  // agent cannot resurrect it into 'error' either — retired is a dead end
  // no heartbeat payload can escape.
  if (input.priorStatus === 'retired') {
    return { kind: 'noop', effectiveStatus: 'retired', isFatalError: false }
  }

  const isFatalError = input.errorSeverity === 'fatal'
  const effectiveStatus: ResolvedStatusLiteral = isFatalError ? 'error' : input.payloadStatus

  // Audit-log only real transitions. No-op heartbeats (status unchanged)
  // happen on every agent heartbeat poll — logging them would dominate
  // log volume. A null priorStatus (agent row missing) is treated as
  // no-op since the caller's UPDATE will match zero rows; the
  // missing-row case is surfaced by processHeartbeat instead.
  if (input.priorStatus === null || input.priorStatus === effectiveStatus) {
    return { kind: 'noop', effectiveStatus, isFatalError }
  }

  return {
    kind: 'transition',
    effectiveStatus,
    isFatalError,
    reason: isFatalError ? 'fatal_error' : 'heartbeat_status',
    fromStatus: input.priorStatus,
  }
}

/**
 * Whole-word secret-name set used by `isSecretKey`. Keys that normalize
 * to one of these names — or that end in `_<secret>` after
 * normalization — are redacted before persistence. The list covers the
 * obvious credential-bearing field names and a few common compounds
 * (e.g., `access_token`, `set_cookie`); add new entries when an agent
 * is observed to spill a different field shape, but keep the matching
 * boundary-aware so descriptive names like `tokenCount` or
 * `cookieDomain` are not falsely redacted.
 */
const SECRET_KEY_NAMES = new Set([
  'token',
  'tokens',
  'password',
  'passwords',
  'passwd',
  'pwd',
  'secret',
  'secrets',
  'api_key',
  'api_keys',
  'apikey',
  'apikeys',
  'authorization',
  'auth',
  'cookie',
  'cookies',
  'set_cookie',
  'bearer',
  'credential',
  'credentials',
  'access_token',
  'refresh_token',
  'id_token',
  'session_token',
  'x_auth_token',
  'x_api_key',
  'x_access_token',
])
const SCRUBBED_VALUE = '[REDACTED]'
const SCRUB_MAX_DEPTH = 6

/**
 * Decide whether a key carries a secret value and must be redacted.
 * Normalizes `apiKey` / `API_KEY` / `api-key` / `api_key` to a single
 * snake_case form, then checks whole-word membership in the set above
 * or `<...>_<secret>` suffix. The earlier substring-based regex was
 * too aggressive — descriptive names like `tokenCount`, `cookieDomain`,
 * and `bearerHostname` were being redacted along with the values
 * operators actually need for debugging.
 *
 * Exported for direct unit testing alongside `scrubAgentErrorContext`.
 */
export function isSecretKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[-\s]+/g, '_')
  if (SECRET_KEY_NAMES.has(normalized)) return true
  // Trailing-secret suffix: `db_password`, `customer_secret`,
  // `x_auth_token` etc. Match only when the last underscore-separated
  // word is a known secret name; this keeps `password_age` (a duration
  // counter, not the password itself) out of scope.
  const parts = normalized.split('_')
  const last = parts[parts.length - 1]
  return !!last && SECRET_KEY_NAMES.has(last)
}

/**
 * Walk an arbitrary jsonb-compatible value, redacting any object key
 * whose name matches the secret pattern. Returns a deep copy so the
 * caller's object is not mutated. Depth-capped to defend against
 * pathological agent payloads (the schema already caps overall
 * serialized size, but a deeply-nested cycle would still be expensive
 * to walk).
 *
 * Exported so unit tests can pin the policy without staging a real
 * agent_errors row.
 */
export function scrubAgentErrorContext(value: unknown, depth = 0): unknown {
  if (depth > SCRUB_MAX_DEPTH) return SCRUBBED_VALUE
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((item) => scrubAgentErrorContext(item, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      out[key] = SCRUBBED_VALUE
    } else {
      out[key] = scrubAgentErrorContext(raw, depth + 1)
    }
  }
  return out
}

/**
 * Typed outcome of `updateAgent` (issue #106 F4 code review), mirroring the
 * `retireAgent` / campaign-archive-service convention (`{ kind }`
 * discriminant, no thrown exceptions for expected outcomes). Backend-
 * internal only — routes translate `kind` into the HTTP envelope, never
 * serialized verbatim, so it does not need a shared Zod schema (see
 * `DeleteResourceResult` in `services/resources.ts` for the same pattern).
 */
export type UpdateAgentResult =
  | { kind: 'updated'; agent: typeof agents.$inferSelect }
  // Row missing OR belongs to a different project -- both collapse to
  // "not found" at the caller (unchanged from the prior `null` contract).
  | { kind: 'not_found' }
  // The agent exists and is in this project, but is retired. Retirement is
  // terminal (ADR-0019 / issue #106 R9, no restore path) and the generic
  // PATCH path must not be able to reverse it -- see the guarded UPDATE
  // WHERE below.
  | { kind: 'retired' }

/**
 * Update an agent, enforcing project scope AND the retired-is-immutable
 * invariant inside the UPDATE WHERE predicate. The atomic form closes two
 * TOCTOU windows the previous "read with getAgentById then write with
 * updateAgent" pattern left open:
 *   1. Ownership could change between the read and the write.
 *   2. (F4) A contributor could PATCH `status: 'online'` on a
 *      just-retired agent, reversing admin-only terminal retirement --
 *      `retireAgent` folds `ne(status, 'retired')` into ITS guarded
 *      UPDATE for the same reason; this generic PATCH path needs the
 *      identical guard so retirement can't be undone through it.
 *
 * `oldRow` is read inside the same transaction as the guarded UPDATE, so a
 * zero-row UPDATE after `oldRow` was found unambiguously means the
 * retired-guard fired (existence + project match were already proven by
 * the `oldRow` read in this same transaction) -- there is no separate
 * race-loss case to re-classify here, unlike the archive/restore services'
 * pre-check-outside-the-transaction pattern.
 */
export async function updateAgent(
  agentId: number,
  data: {
    name?: string | undefined
    status?: string | undefined
  },
  projectId: number,
  actor?: Actor
): Promise<UpdateAgentResult> {
  const DEFAULT_SYSTEM_ACTOR: Actor = { actorType: 'system', actorId: null }
  const resolvedActor = actor ?? DEFAULT_SYSTEM_ACTOR

  const result = await db.transaction(async (tx): Promise<UpdateAgentResult> => {
    const [oldRow] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.projectId, projectId)))
      .limit(1)

    if (!oldRow) return { kind: 'not_found' }

    const [updatedRow] = await tx
      .update(agents)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(eq(agents.id, agentId), eq(agents.projectId, projectId), ne(agents.status, 'retired'))
      )
      .returning()

    if (!updatedRow) return { kind: 'retired' }

    await recordAuditEvent(
      {
        actor: resolvedActor,
        projectId,
        entityType: 'agent',
        entityId: agentId,
        action: 'updated',
        oldRow,
        newRow: updatedRow,
      },
      tx
    )

    return { kind: 'updated', agent: updatedRow }
  })

  if (result.kind === 'updated' && data.status) {
    emitAgentStatus(result.agent.projectId, result.agent.id, data.status)
  }

  return result
}

/**
 * Narrow drizzle client surface shared by both the global `db` and the
 * `tx` argument of `db.transaction((tx) => ...)`. The full
 * `PostgresJsDatabase` type carries a `$client` property that the
 * transactional client doesn't, so we project to the query-builder
 * operations both clients actually share. Lets `logAgentError`
 * participate in an outer transaction (`processHeartbeat`) without
 * widening to `any`.
 */
export type DbClient = Pick<typeof db, 'insert' | 'select' | 'update' | 'delete'>

/**
 * S-H2: rotate an agent's bearer token to a bcrypt-format `agt_*` token.
 * Returns the raw token exactly once for the operator to deliver to the
 * agent out-of-band; the bcrypt hash is the only thing persisted.
 *
 * The UPDATE is atomic and project-scoped: the row is only rotated when
 * `(id, project_id)` match, so a cross-project caller (already caught
 * by the route guards but defended again here) cannot rotate a token
 * they don't own. The plaintext `auth_token` column is cleared in the
 * same statement so a partial rotation never leaves both a usable
 * legacy token AND a usable bcrypt token in place.
 *
 * Returns `null` when the agent is not found in that project; callers
 * map that to 404.
 */
export async function rotateAgentToken(
  agentId: number,
  projectId: number
): Promise<{ token: string } | null> {
  const { generateAgentToken } = await import('../lib/agent-token.js')
  const { token, hash } = await generateAgentToken(agentId)

  const [updated] = await db
    .update(agents)
    .set({
      authToken: null,
      authTokenHash: hash,
      authTokenFormat: 'bcrypt',
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agentId), eq(agents.projectId, projectId)))
    .returning({ id: agents.id })

  if (!updated) return null
  return { token }
}

export async function logAgentError(
  data: {
    agentId: number
    severity: string
    message: string
    context?: Record<string, unknown> | undefined
    taskId?: number | undefined
    // Optional projectId pass-through: hot-path callers (processHeartbeat)
    // already know it and pass it in to avoid an extra SELECT on every
    // error-bearing heartbeat. Callers that don't have it (e.g., the
    // standalone POST /api/v1/agent/errors handler, which only has agentId)
    // can omit it and the function falls back to a DB lookup.
    projectId?: number | undefined
    // When true, the SSE `emitAgentError` is skipped. processHeartbeat
    // sets this so the event fires AFTER the outer transaction commits,
    // preventing listeners from reacting to a state the DB later rolls
    // back. Standalone callers (POST /errors) leave it false.
    suppressEvent?: boolean | undefined
  },
  dbClient: DbClient = db
) {
  const [error] = await dbClient
    .insert(agentErrors)
    .values({
      agentId: data.agentId,
      severity: data.severity,
      message: data.message,
      context: data.context ?? {},
      taskId: data.taskId ?? null,
    })
    .returning()

  // Surface the insertion on the event stream so the detail page's
  // error log refreshes in real time. Use the dedicated `agent_error`
  // event type rather than reusing `agent_status`: the per-type/per-
  // project throttle in events.ts is 250ms keyed on `(eventType,
  // projectId)`, so reusing `agent_status` would silently drop a new
  // error event if a heartbeat just fired for the same project.
  if (error) {
    if (data.suppressEvent) return error
    let projectId = data.projectId
    if (projectId === undefined) {
      const [agent] = await dbClient
        .select({ projectId: agents.projectId })
        .from(agents)
        .where(eq(agents.id, data.agentId))
        .limit(1)
      projectId = agent?.projectId
    }
    if (projectId !== undefined) {
      emitAgentError(projectId, data.agentId, data.severity)
    } else {
      // The row was persisted but we can't route the SSE event without a
      // projectId — should only happen if the agent row was deleted
      // between the insert and the lookup. Log so operators can correlate
      // missing dashboard events with cleanup activity.
      logger.warn(
        { agentId: data.agentId, severity: data.severity },
        'Agent error persisted but project lookup failed; SSE event skipped'
      )
    }
  } else {
    // An INSERT that returns no row means RETURNING was suppressed —
    // RLS, a trigger, or a future schema change. The insert may or may
    // not have succeeded; surface it so a regression isn't silent.
    logger.error(
      { agentId: data.agentId, severity: data.severity },
      'agent_errors insert returned no row; downstream event skipped'
    )
  }

  return error ?? null
}

export async function getAgentErrors(
  agentId: number,
  opts: { limit?: number | undefined; offset?: number | undefined }
) {
  const limit = opts.limit ?? 20
  const offset = opts.offset ?? 0

  return db
    .select()
    .from(agentErrors)
    .where(eq(agentErrors.agentId, agentId))
    .orderBy(desc(agentErrors.createdAt))
    .limit(limit)
    .offset(offset)
}

export async function submitBenchmarks(
  agentId: number,
  entries: ReadonlyArray<{
    readonly hashcatMode: number
    readonly hashType: string
    readonly speedHs: number
    readonly deviceName: string
  }>,
  crackerVersion?: string
) {
  const now = new Date()

  // Deduplicate by hashcatMode -- last entry wins (defense-in-depth; schema also rejects duplicates)
  const deduped = [...new Map(entries.map((e) => [e.hashcatMode, e] as const)).values()]

  // Benchmark insert + agent status update must be atomic
  const rows = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(agentBenchmarks)
      .values(
        deduped.map((e) => ({
          agentId,
          hashcatMode: e.hashcatMode,
          hashType: e.hashType,
          speedHs: e.speedHs,
          deviceName: e.deviceName,
          benchmarkedAt: now,
        }))
      )
      .onConflictDoUpdate({
        target: [agentBenchmarks.agentId, agentBenchmarks.hashcatMode],
        set: {
          speedHs: sql`excluded.speed_hs`,
          hashType: sql`excluded.hash_type`,
          deviceName: sql`excluded.device_name`,
          benchmarkedAt: sql`excluded.benchmarked_at`,
        },
      })
      .returning()

    // Atomically transition to 'benchmarked' only if agent is not busy.
    // The WHERE clause guards against a race where the agent became busy
    // between transaction start and this update — if so, the row simply
    // won't match and the status stays unchanged.
    const agentUpdates = {
      updatedAt: now,
      status: 'benchmarked' as const,
      ...(crackerVersion !== undefined ? { crackerVersion } : {}),
    }

    await tx
      .update(agents)
      .set(agentUpdates)
      .where(and(eq(agents.id, agentId), sql`${agents.status} != 'busy'`))

    return inserted
  })

  // Event emission is best-effort, outside the transaction
  const agent = await getAgentById(agentId)
  if (agent) {
    emitAgentStatus(agent.projectId, agent.id, agent.status)
  }

  return rows
}

export async function getBenchmarksForAgent(agentId: number): Promise<SelectAgentBenchmark[]> {
  return db
    .select()
    .from(agentBenchmarks)
    .where(eq(agentBenchmarks.agentId, agentId))
    .orderBy(desc(agentBenchmarks.benchmarkedAt))
}

export async function getAgentBenchmarkForMode(
  agentId: number,
  hashcatMode: number
): Promise<SelectAgentBenchmark | null> {
  const [row] = await db
    .select()
    .from(agentBenchmarks)
    .where(and(eq(agentBenchmarks.agentId, agentId), eq(agentBenchmarks.hashcatMode, hashcatMode)))
    .limit(1)
  return row ?? null
}

// ─── Re-exports from ./agents/heartbeat.ts (CQ-H4 / P-H1 split) ─────
//
// processHeartbeat + the test-only reset live in their own module
// now. We re-export here so existing callers
// (services/agents.ts importers, tests that import the reset helper
// from this module's path) keep compiling without touching their
// import paths.
export { processHeartbeat, __resetWarnedEmptyCapsForTesting } from './agents/heartbeat.js'

// ─── Re-exports from ./agents-retire.ts (issue #106 U8) ─────────────
//
// retireAgent lives in its own module (mirrors resources.ts /
// resources-archive.ts and campaigns.ts / campaigns-attacks-archive.ts)
// so this file's core CRUD/heartbeat layer stays under the project's
// file-size guideline. Re-exported here so existing callers keep
// importing from services/agents.js unchanged.
export { retireAgent, type RetireAgentResult } from './agents-retire.js'
