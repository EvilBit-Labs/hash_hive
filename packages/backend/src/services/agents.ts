import type {
  AgentCurrentTask,
  AgentHeartbeat,
  AgentWorstSeverity,
  SelectAgentBenchmark,
} from '@hashhive/shared';
import { agentBenchmarks, agentErrors, agents, attacks, campaigns, tasks } from '@hashhive/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { emitAgentError, emitAgentStatus } from './events.js';

// SelectAgent from @hashhive/shared is the zod-strict shape (jsonb as Json),
// but Drizzle's row selection narrows jsonb to `unknown`. Deriving from
// getAgentById's return shape keeps AgentListRow assignable from the raw row
// without bouncing through a Json cast.
type SelectedAgent = NonNullable<Awaited<ReturnType<typeof getAgentById>>>;

export type AgentListRow = SelectedAgent & {
  errorCount24h: number;
  worstSeverity24h: AgentWorstSeverity;
  currentTask: AgentCurrentTask | null;
};

// currentTask on the list response only shows tasks the agent is actively
// executing — pending tasks (queued for an agent but not yet started) are not
// surfaced here. The detail page's listTasksByAgent intentionally includes
// 'pending' (see AGENT_TASK_ACTIVE_STATUSES in services/tasks.ts) so operators
// can see the full queue for one agent.
const ACTIVE_TASK_STATUSES = ['assigned', 'running'] as const;

// Severity policy for the 24h error badge.
// `info`/`debug`/`notice` and other unknown severities intentionally do not
// contribute to the count or the badge color — the SQL `count(*) FILTER`
// applies the same allowlist, so the two layers can't drift.
export const FATAL_SEVERITIES = ['fatal', 'critical', 'error'];
export const WARNING_SEVERITIES = ['warning'];

/**
 * Classify a severity-allowlist hit pair into the three-state badge.
 * Pure function exported so the policy is unit-testable without touching
 * the database.
 */
export function classifyWorstSeverity(opts: {
  hasFatal: boolean;
  hasWarning: boolean;
}): AgentWorstSeverity {
  if (opts.hasFatal) return 'fatal';
  if (opts.hasWarning) return 'warning';
  return null;
}

/**
 * Test-only helper: classify a buffered set of severity rows the same way
 * the SQL aggregate does. Mirrors the FILTER/bool_or behavior in
 * aggregateRecentErrors so tests can pin the policy without a database.
 */
export function classifyRecentErrors(rows: { severity: string }[]): {
  count: number;
  worstSeverity: AgentWorstSeverity;
} {
  let hasFatal = false;
  let hasWarning = false;
  let count = 0;
  for (const row of rows) {
    const lower = row.severity.toLowerCase();
    const isFatal = FATAL_SEVERITIES.includes(lower);
    const isWarning = WARNING_SEVERITIES.includes(lower);
    if (isFatal || isWarning) count += 1;
    if (isFatal) hasFatal = true;
    if (isWarning) hasWarning = true;
  }
  return { count, worstSeverity: classifyWorstSeverity({ hasFatal, hasWarning }) };
}

interface ActiveTaskRow {
  taskId: number;
  status: string;
  campaignId: number;
  campaignName: string;
  attackId: number;
  attackMode: number;
  startedAt?: Date | string | null | undefined;
  assignedAt?: Date | string | null | undefined;
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
    if (!v) return 0;
    if (v instanceof Date) return v.getTime();
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const sorted = [...rows]
    .filter((r): r is ActiveTaskRow & { agentId: number } => r.agentId !== null)
    .sort((a, b) => {
      const statusRank = (s: string) => (s === 'running' ? 0 : 1);
      const byStatus = statusRank(a.status) - statusRank(b.status);
      if (byStatus !== 0) return byStatus;
      const byStarted = ts(b.startedAt) - ts(a.startedAt);
      if (byStarted !== 0) return byStarted;
      return ts(b.assignedAt) - ts(a.assignedAt);
    });
  const map = new Map<number, AgentCurrentTask>();
  for (const row of sorted) {
    if (map.has(row.agentId)) continue;
    map.set(row.agentId, {
      id: row.taskId,
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      attackId: row.attackId,
      attackMode: row.attackMode,
      status: row.status,
    });
  }
  return map;
}

export async function getAgentById(agentId: number) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  return agent ?? null;
}

export async function listAgents(filters: {
  projectId?: number | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): Promise<{
  agents: AgentListRow[];
  total: number;
  limit: number;
  offset: number;
}> {
  let query = db.select().from(agents).$dynamic();

  const conditions = [];
  if (filters.projectId) {
    conditions.push(eq(agents.projectId, filters.projectId));
  }
  if (filters.status) {
    conditions.push(eq(agents.status, filters.status));
  }
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const [results, countResult] = await Promise.all([
    query.limit(limit).offset(offset).orderBy(desc(agents.lastSeenAt)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(agents)
      .where(conditions.length > 0 ? and(...conditions) : undefined),
  ]);

  const agentIds = results.map((a) => a.id);
  const [errorAggregates, currentTasks] = await Promise.all([
    aggregateRecentErrors(agentIds),
    fetchCurrentTasks(agentIds),
  ]);

  const enriched: AgentListRow[] = results.map((agent) => ({
    ...agent,
    errorCount24h: errorAggregates.get(agent.id)?.count ?? 0,
    worstSeverity24h: errorAggregates.get(agent.id)?.worstSeverity ?? null,
    currentTask: currentTasks.get(agent.id) ?? null,
  }));

  return {
    agents: enriched,
    total: Number(countResult[0]?.count ?? 0),
    limit,
    offset,
  };
}

async function aggregateRecentErrors(
  agentIds: number[]
): Promise<Map<number, { count: number; worstSeverity: AgentWorstSeverity }>> {
  const map = new Map<number, { count: number; worstSeverity: AgentWorstSeverity }>();
  if (agentIds.length === 0) {
    return map;
  }

  // Server-side aggregation: bounded wire size at one row per agent, regardless
  // of how many errors a noisy agent emits. Unknown severities (info/debug/...)
  // are excluded from `count` and from the `hasWarning` / `hasFatal` flags.
  const fatalArray = sql`ARRAY[${sql.raw(FATAL_SEVERITIES.map((s) => `'${s}'`).join(','))}]::text[]`;
  const warningArray = sql`ARRAY[${sql.raw(WARNING_SEVERITIES.map((s) => `'${s}'`).join(','))}]::text[]`;

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
    .groupBy(agentErrors.agentId);

  for (const row of rows) {
    const count = Number(row.count ?? 0);
    if (count === 0) continue;
    map.set(row.agentId, {
      count,
      worstSeverity: classifyWorstSeverity({
        hasFatal: Boolean(row.hasFatal),
        hasWarning: Boolean(row.hasWarning),
      }),
    });
  }

  return map;
}

async function fetchCurrentTasks(
  agentIds: number[]
): Promise<Map<number, AgentListRow['currentTask']>> {
  const map = new Map<number, AgentListRow['currentTask']>();
  if (agentIds.length === 0) {
    return map;
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
    );

  const selected = pickCurrentTaskByAgent(rows);
  for (const [agentId, task] of selected) {
    map.set(agentId, task);
  }

  return map;
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
export type StatusTransitionReason = 'fatal_error' | 'heartbeat_status';

export interface HeartbeatTransition {
  effectiveStatus: string;
  isFatalError: boolean;
  shouldLogTransition: boolean;
  reason: StatusTransitionReason | null;
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
  payloadStatus: string;
  errorSeverity?: 'warning' | 'fatal' | undefined;
  priorStatus: string | null;
}): HeartbeatTransition {
  const isFatalError = input.errorSeverity === 'fatal';
  const effectiveStatus = isFatalError ? 'error' : input.payloadStatus;

  // Audit-log only real transitions. No-op heartbeats (status unchanged)
  // happen every ~30s per agent — logging them would dominate volume.
  // A null priorStatus (agent row missing) is treated as no-op since the
  // update will fail anyway.
  const shouldLogTransition = input.priorStatus !== null && input.priorStatus !== effectiveStatus;

  const reason: StatusTransitionReason | null = !shouldLogTransition
    ? null
    : isFatalError
      ? 'fatal_error'
      : 'heartbeat_status';

  return { effectiveStatus, isFatalError, shouldLogTransition, reason };
}

function logStatusTransition(opts: {
  agentId: number;
  projectId: number;
  fromStatus: string;
  toStatus: string;
  reason: StatusTransitionReason;
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
  );
}

export async function processHeartbeat(agentId: number, data: AgentHeartbeat) {
  // Read the prior status before we mutate the row so the audit log can
  // record the actual transition (the UPDATE ... RETURNING below only
  // exposes the post-update state).
  const [priorRow] = await db
    .select({ status: agents.status, projectId: agents.projectId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const priorStatus = priorRow?.status ?? null;

  const transition = decideHeartbeatTransition({
    payloadStatus: data.status,
    errorSeverity: data.error?.severity,
    priorStatus,
  });
  const { effectiveStatus, isFatalError } = transition;

  // Persist heartbeat-borne errors to agent_errors regardless of severity.
  // Warnings are recorded but do not change status or fail the running
  // task; fatals are recorded AND drive the status/task transitions
  // below. Heartbeats and the standalone POST /errors endpoint are
  // intentionally non-redundant channels — an agent posts via one or the
  // other for a given event, never both, because the server has no
  // idempotency key to dedupe across channels.
  if (data.error) {
    await logAgentError({
      agentId,
      severity: data.error.severity,
      message: data.error.message,
      context: data.error.context,
      taskId: data.currentTask?.taskId,
    });
  }

  const updates: Record<string, unknown> = {
    status: effectiveStatus,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  };

  if (data.capabilities) {
    updates['capabilities'] = data.capabilities;
  }
  if (data.deviceInfo) {
    updates['hardwareProfile'] = data.deviceInfo;
  }

  const [updated] = await db.update(agents).set(updates).where(eq(agents.id, agentId)).returning();

  if (updated) {
    emitAgentStatus(updated.projectId, updated.id, effectiveStatus);

    if (transition.shouldLogTransition && transition.reason && priorStatus) {
      logStatusTransition({
        agentId: updated.id,
        projectId: updated.projectId,
        fromStatus: priorStatus,
        toStatus: effectiveStatus,
        reason: transition.reason,
      });
    }
  }

  // On fatal error, fail the agent's current tasks. `handleTaskFailure`
  // applies the up-to-3-retry policy defined in the ticket; rolling a
  // parallel path here would diverge. Dynamic import preserves the
  // existing tasks.ts <-> agents.ts circular-import workaround.
  if (isFatalError) {
    const activeTasks = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.agentId, agentId), sql`${tasks.status} IN ('assigned', 'running')`));

    const { handleTaskFailure } = await import('./tasks.js');
    for (const activeTask of activeTasks) {
      await handleTaskFailure(activeTask.id, agentId, data.error?.message ?? 'Agent fatal error');
    }
  }

  // Check if there are high-priority pending tasks for this agent's project
  let hasHighPriorityTasks = false;
  if (updated) {
    const { campaigns } = await import('@hashhive/shared');
    const [highPriority] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
      .where(
        and(
          eq(tasks.status, 'pending'),
          eq(campaigns.projectId, updated.projectId),
          sql`${campaigns.priority} <= 1`
        )
      )
      .limit(1);
    hasHighPriorityTasks = !!highPriority;
  }

  return { agent: updated ?? null, hasHighPriorityTasks };
}

export async function updateAgent(
  agentId: number,
  data: {
    name?: string | undefined;
    status?: string | undefined;
  }
) {
  const [updated] = await db
    .update(agents)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();

  if (updated && data.status) {
    emitAgentStatus(updated.projectId, updated.id, data.status);
  }

  return updated ?? null;
}

export async function logAgentError(data: {
  agentId: number;
  severity: string;
  message: string;
  context?: Record<string, unknown> | undefined;
  taskId?: number | undefined;
}) {
  const [error] = await db
    .insert(agentErrors)
    .values({
      agentId: data.agentId,
      severity: data.severity,
      message: data.message,
      context: data.context ?? {},
      taskId: data.taskId ?? null,
    })
    .returning();

  // Surface the insertion on the event stream so the detail page's
  // error log refreshes in real time. Use the dedicated `agent_error`
  // event type rather than reusing `agent_status`: the per-type/per-
  // project throttle in events.ts is 250ms keyed on `(eventType,
  // projectId)`, so reusing `agent_status` would silently drop a new
  // error event if a heartbeat just fired for the same project.
  if (error) {
    const [agent] = await db
      .select({ projectId: agents.projectId })
      .from(agents)
      .where(eq(agents.id, data.agentId))
      .limit(1);
    if (agent) {
      emitAgentError(agent.projectId, data.agentId, data.severity);
    }
  }

  return error ?? null;
}

export async function getAgentErrors(
  agentId: number,
  opts: { limit?: number | undefined; offset?: number | undefined }
) {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  return db
    .select()
    .from(agentErrors)
    .where(eq(agentErrors.agentId, agentId))
    .orderBy(desc(agentErrors.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function submitBenchmarks(
  agentId: number,
  entries: ReadonlyArray<{
    readonly hashcatMode: number;
    readonly hashType: string;
    readonly speedHs: number;
    readonly deviceName: string;
  }>,
  crackerVersion?: string
) {
  const now = new Date();

  // Deduplicate by hashcatMode -- last entry wins (defense-in-depth; schema also rejects duplicates)
  const deduped = [...new Map(entries.map((e) => [e.hashcatMode, e] as const)).values()];

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
      .returning();

    // Atomically transition to 'benchmarked' only if agent is not busy.
    // The WHERE clause guards against a race where the agent became busy
    // between transaction start and this update — if so, the row simply
    // won't match and the status stays unchanged.
    const agentUpdates = {
      updatedAt: now,
      status: 'benchmarked' as const,
      ...(crackerVersion !== undefined ? { crackerVersion } : {}),
    };

    await tx
      .update(agents)
      .set(agentUpdates)
      .where(and(eq(agents.id, agentId), sql`${agents.status} != 'busy'`));

    return inserted;
  });

  // Event emission is best-effort, outside the transaction
  const agent = await getAgentById(agentId);
  if (agent) {
    emitAgentStatus(agent.projectId, agent.id, agent.status);
  }

  return rows;
}

export async function getBenchmarksForAgent(agentId: number): Promise<SelectAgentBenchmark[]> {
  return db
    .select()
    .from(agentBenchmarks)
    .where(eq(agentBenchmarks.agentId, agentId))
    .orderBy(desc(agentBenchmarks.benchmarkedAt));
}

export async function getAgentBenchmarkForMode(
  agentId: number,
  hashcatMode: number
): Promise<SelectAgentBenchmark | null> {
  const [row] = await db
    .select()
    .from(agentBenchmarks)
    .where(and(eq(agentBenchmarks.agentId, agentId), eq(agentBenchmarks.hashcatMode, hashcatMode)))
    .limit(1);
  return row ?? null;
}
