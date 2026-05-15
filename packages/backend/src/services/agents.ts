import type { SelectAgentBenchmark } from '@hashhive/shared';
import { agentBenchmarks, agentErrors, agents, attacks, campaigns, tasks } from '@hashhive/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { emitAgentStatus } from './events.js';

type WorstSeverity = 'warning' | 'fatal' | null;

interface CurrentTaskSummary {
  id: number;
  campaignId: number;
  campaignName: string;
  attackId: number;
  attackMode: number;
  status: string;
}

type SelectedAgent = NonNullable<Awaited<ReturnType<typeof getAgentById>>>;

export type AgentListRow = SelectedAgent & {
  errorCount24h: number;
  worstSeverity24h: WorstSeverity;
  currentTask: CurrentTaskSummary | null;
};

// currentTask on the list response only shows tasks the agent is actively
// executing — pending tasks (queued for an agent but not yet started) are not
// surfaced here. The detail page's listTasksByAgent intentionally includes
// 'pending' so operators can see the full queue for one agent.
const ACTIVE_TASK_STATUSES = ['assigned', 'running'] as const;

// Severity policy for the 24h error badge:
//   * fatal = any error severity at or above ordinary "error" (an error worth
//     paging on — fatal/critical/error).
//   * warning = explicit warnings only.
// Lower-importance severities (info/debug/notice/etc.) do not contribute to
// the count or the badge color.
const FATAL_SEVERITIES = ['fatal', 'critical', 'error'];
const WARNING_SEVERITIES = ['warning'];

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
): Promise<Map<number, { count: number; worstSeverity: WorstSeverity }>> {
  const map = new Map<number, { count: number; worstSeverity: WorstSeverity }>();
  if (agentIds.length === 0) {
    return map;
  }

  // Server-side aggregation: bounded wire size at one row per agent, regardless
  // of how many errors a noisy agent emits. Unknown severities (info/debug/...)
  // are excluded from `count` and from the `has_warning` / `has_fatal` flags.
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
      worstSeverity: row.hasFatal ? 'fatal' : row.hasWarning ? 'warning' : null,
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
    })
    .from(tasks)
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .innerJoin(attacks, eq(tasks.attackId, attacks.id))
    .where(and(inArray(tasks.agentId, agentIds), inArray(tasks.status, [...ACTIVE_TASK_STATUSES])))
    // Deterministic ordering when an agent has multiple active tasks:
    // prefer 'running' over 'assigned', then most recently started, then most
    // recently assigned.
    .orderBy(
      sql`CASE WHEN ${tasks.status} = 'running' THEN 0 ELSE 1 END`,
      desc(tasks.startedAt),
      desc(tasks.assignedAt)
    );

  for (const row of rows) {
    if (row.agentId === null || map.has(row.agentId)) {
      continue;
    }
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

export async function processHeartbeat(
  agentId: number,
  data: {
    status: string;
    capabilities?: Record<string, unknown> | undefined;
    deviceInfo?: Record<string, unknown> | undefined;
    error?: { severity?: string; message?: string } | undefined;
  }
) {
  // Determine effective status from heartbeat payload
  let effectiveStatus = data.status;
  const isFatalError = data.error?.severity === 'fatal';
  if (isFatalError) {
    effectiveStatus = 'error';
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
  }

  // On fatal error, fail the agent's current tasks
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
