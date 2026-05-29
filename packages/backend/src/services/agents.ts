import type {
  AgentCurrentTask,
  AgentHeartbeat,
  AgentHeartbeatError,
  AgentWorstSeverity,
  SelectAgentBenchmark,
} from '@hashhive/shared'

import { agentBenchmarks, agentErrors, agents, attacks, campaigns, tasks } from '@hashhive/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { emitAgentError, emitAgentStatus } from './events.js'

// SelectAgent from @hashhive/shared is the zod-strict shape (jsonb as Json),
// but Drizzle's row selection narrows jsonb to `unknown`. Deriving from
// getAgentById's return shape keeps AgentListRow assignable from the raw row
// without bouncing through a Json cast.
type SelectedAgent = NonNullable<Awaited<ReturnType<typeof getAgentById>>>

export type AgentListRow = SelectedAgent & {
  errorCount24h: number
  worstSeverity24h: AgentWorstSeverity
  currentTask: AgentCurrentTask | null
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

  const enriched: AgentListRow[] = results.map((agent) => ({
    ...agent,
    errorCount24h: errorAggregates.get(agent.id)?.count ?? 0,
    worstSeverity24h: errorAggregates.get(agent.id)?.worstSeverity ?? null,
    currentTask: currentTasks.get(agent.id) ?? null,
  }))

  return {
    agents: enriched,
    total: Number(countResult[0]?.count ?? 0),
    limit,
    offset,
  }
}

async function aggregateRecentErrors(
  agentIds: number[]
): Promise<Map<number, { count: number; worstSeverity: AgentWorstSeverity }>> {
  const map = new Map<number, { count: number; worstSeverity: AgentWorstSeverity }>()
  if (agentIds.length === 0) {
    return map
  }

  // Server-side aggregation: bounded wire size at one row per agent, regardless
  // of how many errors a noisy agent emits. Unknown severities (info/debug/...)
  // are excluded from `count` and from the `hasWarning` / `hasFatal` flags.
  const fatalArray = sql`ARRAY[${sql.raw(FATAL_SEVERITIES.map((s) => `'${s}'`).join(','))}]::text[]`
  const warningArray = sql`ARRAY[${sql.raw(WARNING_SEVERITIES.map((s) => `'${s}'`).join(','))}]::text[]`

  const rows = await db
    .select({
      agentId: agentErrors.agentId,
      count: sql<number>`count(*) FILTER (WHERE lower(${agentErrors.severity}) = ANY(${fatalArray}) OR lower(${agentErrors.severity}) = ANY(${warningArray}))`,
      hasFatal: sql<boolean>`bool_or(lower(${agentErrors.severity}) = ANY(${fatalArray}))`,
      hasWarning: sql<boolean>`bool_or(lower(${agentErrors.severity}) = ANY(${warningArray}))`,
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
    if (count === 0) continue
    map.set(row.agentId, {
      count,
      worstSeverity: classifyWorstSeverity({
        hasFatal: Boolean(row.hasFatal),
        hasWarning: Boolean(row.hasWarning),
      }),
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
type ResolvedStatusLiteral = HeartbeatStatusLiteral | 'error'

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
 * Lazy reference to `handleTaskFailure` from `./tasks.js`. The static
 * import path is blocked by the circular dependency between
 * `services/agents.ts` and `services/tasks.ts` (tasks imports
 * `getAgentBenchmarkForMode` from this module). We resolve the module
 * once on first use and cache the function reference so every
 * subsequent fatal heartbeat skips the import-resolution roundtrip.
 *
 * Returns `null` (and logs) on import failure or unexpected export shape
 * so callers can degrade gracefully instead of bubbling a 500 to the
 * agent — the heartbeat must stay alive so the agent can keep checking
 * in even if a downstream module is misbehaving.
 */
let cachedHandleTaskFailure: typeof import('./tasks.js').handleTaskFailure | null = null

async function getHandleTaskFailure(): Promise<
  typeof import('./tasks.js').handleTaskFailure | null
> {
  if (cachedHandleTaskFailure != null) {
    return cachedHandleTaskFailure
  }
  try {
    const mod = await import('./tasks.js')
    if (typeof mod.handleTaskFailure !== 'function') {
      logger.error(
        { exportType: typeof mod.handleTaskFailure },
        'handleTaskFailure export is not a function — possible circular-import edge'
      )
      return null
    }
    cachedHandleTaskFailure = mod.handleTaskFailure
    return cachedHandleTaskFailure
  } catch (err) {
    logger.error({ err }, 'Failed to lazy-import handleTaskFailure from ./tasks.js')
    return null
  }
}

/**
 * Lazy reference to `buildCapabilityPredicate` from `./tasks.js`. Same
 * circular-import workaround as `getHandleTaskFailure` above — the heartbeat
 * high-priority check must filter against the agent's capabilities so we
 * never tell an agent to ask for work it cannot actually claim. Returns
 * `null` on import failure so the caller can degrade by omitting the
 * high-priority hint rather than 500-ing the heartbeat.
 */
let cachedBuildCapabilityPredicate: typeof import('./tasks.js').buildCapabilityPredicate | null =
  null

async function getBuildCapabilityPredicate(): Promise<
  typeof import('./tasks.js').buildCapabilityPredicate | null
> {
  if (cachedBuildCapabilityPredicate != null) {
    return cachedBuildCapabilityPredicate
  }
  try {
    const mod = await import('./tasks.js')
    if (typeof mod.buildCapabilityPredicate !== 'function') {
      logger.error(
        { exportType: typeof mod.buildCapabilityPredicate },
        'buildCapabilityPredicate export is not a function — possible circular-import edge'
      )
      return null
    }
    cachedBuildCapabilityPredicate = mod.buildCapabilityPredicate
    return cachedBuildCapabilityPredicate
  } catch (err) {
    logger.error({ err }, 'Failed to lazy-import buildCapabilityPredicate from ./tasks.js')
    return null
  }
}

/**
 * Once-per-agent guard for the "empty/malformed capabilities" warn. The
 * Set lives for the process lifetime so a noisy agent doesn't flood logs
 * each heartbeat. Operators see one warn per agent until the agent
 * announces real capabilities.
 */
const warnedEmptyCapsAgentIds = new Set<number>()

/**
 * Test-only reset for the warned-agent guard. Integration tests that
 * exercise the empty-capabilities path within a single process need to
 * reach the warn branch repeatedly with the same mock agent id; this
 * keeps the production guard intact while letting tests start each case
 * from a known empty state.
 */
export function __resetWarnedEmptyCapsForTesting(): void {
  warnedEmptyCapsAgentIds.clear()
}

function logStatusTransition(opts: {
  agentId: number
  projectId: number
  fromStatus: string
  toStatus: string
  reason: StatusTransitionReason
}): void {
  logger.info(
    {
      agentId: opts.agentId,
      projectId: opts.projectId,
      fromStatus: opts.fromStatus,
      toStatus: opts.toStatus,
      reason: opts.reason,
    },
    'Agent status transition'
  )
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
 * Verify that a heartbeat-supplied `currentTask.taskId` belongs to the
 * calling agent. Returns the taskId when ownership checks out,
 * `undefined` when it doesn't — `processHeartbeat` then persists the
 * error without the task linkage instead of attributing it to another
 * agent's task. Emits a `logger.warn` on mismatch so operators can
 * detect compromised tokens trying to corrupt audit trails.
 *
 * Accepts a drizzle client so the verification can run inside the same
 * transaction as the agent_errors insert; the `for: 'update'` lock on
 * the task row closes the window where a concurrent reassignment
 * between verify and insert could let an error row reference a task
 * the agent no longer owns.
 */
async function verifyTaskOwnership(
  dbClient: DbClient,
  agentId: number,
  taskId: number | undefined
): Promise<number | undefined> {
  if (taskId === undefined) return undefined
  const [row] = await dbClient
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.agentId, agentId)))
    .for('update')
    .limit(1)
  if (row) return row.id
  logger.warn(
    { agentId, taskId },
    'Heartbeat referenced currentTask.taskId not owned by this agent; dropping task linkage'
  )
  return undefined
}

export async function processHeartbeat(agentId: number, data: AgentHeartbeat) {
  // Atomic block: lock the agent row, capture the prior status, verify
  // `currentTask.taskId` ownership (with a row lock so a concurrent
  // reassignment cannot land between the verify and the insert),
  // persist the heartbeat-borne error row, and update the agent's
  // status in a single transaction. The FOR UPDATE locks close the
  // TOCTOU race where two concurrent heartbeats would both observe
  // the same prior status (per GOTCHAS.md "atomic status guards").
  // Emits and the fatal-task-failure loop are deferred until after
  // commit so SSE clients never see a status that was rolled back.
  const txResult = await db.transaction(async (tx) => {
    const [priorRow] = await tx
      .select({ status: agents.status, projectId: agents.projectId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for('update')
      .limit(1)

    const priorStatus = priorRow?.status ?? null

    const transition = decideHeartbeatTransition({
      payloadStatus: data.status,
      errorSeverity: data.error?.severity,
      priorStatus,
    })

    const ownedTaskId = await verifyTaskOwnership(tx, agentId, data.currentTask?.taskId)

    if (data.error) {
      await logAgentError(
        {
          agentId,
          severity: data.error.severity,
          message: data.error.message,
          context: scrubAgentErrorContext(data.error.context) as
            | Record<string, unknown>
            | undefined,
          taskId: ownedTaskId,
          // Skip the redundant SELECT inside logAgentError — priorRow
          // already has projectId.
          projectId: priorRow?.projectId,
          // emitAgentError defers until after commit; suppress here.
          suppressEvent: true,
        },
        tx
      )
    }

    const updates: Record<string, unknown> = {
      status: transition.effectiveStatus,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    }
    if (data.capabilities) updates['capabilities'] = data.capabilities
    if (data.deviceInfo) updates['hardwareProfile'] = data.deviceInfo

    const [updated] = await tx.update(agents).set(updates).where(eq(agents.id, agentId)).returning()

    return { updated, transition, priorStatus }
  })

  const { updated, transition } = txResult

  // Post-commit emits + audit log. If the transaction rolled back,
  // none of these fire and SSE listeners stay consistent. The try/catch
  // around the block swallows failures (log without rethrow) so a flaky
  // SSE bus or audit sink cannot cause the route to return 500 *after*
  // the agent row was already committed — that would mislead operators
  // into thinking the heartbeat failed when DB state was actually
  // persisted. The agent re-heartbeats and SSE listeners catch up on
  // the next cycle.
  //
  // The catch is block-level on purpose: if any single emit throws, the
  // remaining emits and the audit log are skipped. The three emits share
  // an SSE bus so a failure in one is a strong signal the next would
  // also fail, and the audit miss is intentional rather than logged
  // twice — the next heartbeat heals SSE state regardless.
  if (updated) {
    try {
      if (data.error) {
        emitAgentError(updated.projectId, updated.id, data.error.severity)
      }
      emitAgentStatus(updated.projectId, updated.id, transition.effectiveStatus)

      if (transition.kind === 'transition') {
        logStatusTransition({
          agentId: updated.id,
          projectId: updated.projectId,
          fromStatus: transition.fromStatus,
          toStatus: transition.effectiveStatus,
          reason: transition.reason,
        })
      }
    } catch (postCommitErr: unknown) {
      logger.error(
        { err: postCommitErr, agentId: updated.id, projectId: updated.projectId },
        'Post-commit heartbeat emit/audit failed; agent state was already committed'
      )
    }
  } else {
    // Auth middleware verified the agent's bearer token, so the row was
    // present a moment ago. A vanishing row mid-heartbeat means it was
    // deleted concurrently — surface it so an operator can correlate
    // bursts of "ghost heartbeat" warnings with cleanup actions.
    logger.warn(
      { agentId, status: transition.effectiveStatus },
      'Heartbeat for an agent row that no longer exists'
    )
  }

  // Fail the agent's active tasks on fatal-error heartbeats. Each task
  // runs in its own try/catch so a single failure does not strand
  // sibling tasks; partial failures are logged and surfaced in the
  // return shape so callers / monitoring can detect them. Runs AFTER
  // the agent-row tx commits because handleTaskFailure does its own
  // DB work (including transactional retries) and nesting drizzle
  // transactions inside the same connection produces savepoint churn
  // we don't need here.
  let taskFailureSummary: { attempted: number; failed: number } | undefined
  if (transition.isFatalError) {
    const activeTasks = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.agentId, agentId), sql`${tasks.status} IN ('assigned', 'running')`))

    const handleTaskFailure = await getHandleTaskFailure()
    let failed = 0
    if (handleTaskFailure === null) {
      // Lazy import failed - count every active task as failed-to-fail so the
      // summary still gives operators a non-zero failure count to investigate.
      failed = activeTasks.length
      logger.error(
        { agentId, attempted: activeTasks.length },
        'handleTaskFailure unavailable on fatal heartbeat; active tasks left in their current status until the sweep reaps them'
      )
    } else {
      for (const activeTask of activeTasks) {
        try {
          await handleTaskFailure(
            activeTask.id,
            agentId,
            data.error?.message ?? 'Agent fatal error'
          )
        } catch (err) {
          failed += 1
          logger.error(
            { err, agentId, taskId: activeTask.id },
            'handleTaskFailure threw during fatal-heartbeat fan-out; sibling tasks continue'
          )
        }
      }
    }
    taskFailureSummary = { attempted: activeTasks.length, failed }
  }

  // Check if there are high-priority pending tasks for this agent's project.
  // Filter against the agent's capabilities so we don't tell an agent to ask
  // for work it cannot actually claim — buildCapabilityPredicate matches the
  // SQL filter assignNextTask uses for the real claim.
  //
  // Gated on online/benchmarked status because assignNextTask refuses to
  // assign to any other status, so suggesting work to an agent in 'error'
  // or 'offline' is both useless and misleading.
  let hasHighPriorityTasks = false
  const isClaimEligible = updated?.status === 'online' || updated?.status === 'benchmarked'
  if (updated && isClaimEligible) {
    const rawCaps = updated.capabilities
    const capsIsObject = rawCaps !== null && typeof rawCaps === 'object' && !Array.isArray(rawCaps)
    // An agent that has not yet announced is operationally equivalent to one
    // with malformed capabilities: `buildCapabilityPredicate` would emit a
    // filter that excludes every real hashcat task (every task carries a
    // `hashcatMode` requirement), so the hint silently zero-matches AND we
    // pay for an extra DB join per heartbeat. Treat "no usable hashModes"
    // (missing key, empty array, or all-invalid entries) the same as
    // null/non-object: warn once, skip the lookup.
    const hasUsableHashModes =
      capsIsObject &&
      Array.isArray((rawCaps as Record<string, unknown>)['hashModes']) &&
      ((rawCaps as Record<string, unknown>)['hashModes'] as unknown[]).some((m) => {
        const n = Number(m)
        return Number.isFinite(n) && Number.isInteger(n)
      })
    if (!capsIsObject || !hasUsableHashModes) {
      if (!warnedEmptyCapsAgentIds.has(agentId)) {
        warnedEmptyCapsAgentIds.add(agentId)
        const capabilitiesType = !capsIsObject
          ? rawCaps === null
            ? 'null'
            : typeof rawCaps
          : 'object-without-usable-hashModes'
        logger.warn(
          { agentId, capabilitiesType },
          'Agent has empty or non-object capabilities — high-priority hint disabled until announce'
        )
      }
    } else {
      const buildCapabilityPredicate = await getBuildCapabilityPredicate()
      if (buildCapabilityPredicate === null) {
        // Lazy import failed; degrade by omitting the hint. The agent will
        // still pick up work through the normal claim path on the next
        // /tasks/next call — the hint is a latency optimization, not a
        // correctness requirement.
      } else {
        const agentCaps = rawCaps as Record<string, unknown>
        const capabilityPredicate = buildCapabilityPredicate(agentCaps)
        const [highPriority] = await db
          .select({ id: tasks.id })
          .from(tasks)
          .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
          .where(
            and(
              eq(tasks.status, 'pending'),
              eq(campaigns.projectId, updated.projectId),
              sql`${campaigns.priority} <= 1`,
              capabilityPredicate
            )
          )
          .limit(1)
        hasHighPriorityTasks = !!highPriority
      }
    }
  }

  return {
    agent: updated ?? null,
    hasHighPriorityTasks,
    ...(taskFailureSummary ? { taskFailureSummary } : {}),
  }
}

/**
 * Update an agent, enforcing project scope inside the UPDATE WHERE
 * predicate. The atomic form closes the TOCTOU window the previous
 * "read with getAgentById then write with updateAgent" pattern left
 * open: ownership could change between the read and the write, and
 * the write would still land. Returns null when the row does not
 * exist OR when it belongs to a different project -- both cases
 * collapse to "not found" at the caller.
 */
export async function updateAgent(
  agentId: number,
  data: {
    name?: string | undefined
    status?: string | undefined
  },
  projectId: number
) {
  const [updated] = await db
    .update(agents)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.projectId, projectId)))
    .returning()

  if (updated && data.status) {
    emitAgentStatus(updated.projectId, updated.id, data.status)
  }

  return updated ?? null
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
type DbClient = Pick<typeof db, 'insert' | 'select' | 'update' | 'delete'>

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
