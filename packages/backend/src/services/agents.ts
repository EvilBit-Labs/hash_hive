import { agentErrors, agents, tasks } from '@hashhive/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { emitAgentStatus } from './events.js';
import { handleTaskFailure } from './tasks.js';

export async function getAgentById(agentId: number) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  return agent ?? null;
}

export async function listAgents(filters: {
  projectId?: number | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}) {
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

  return {
    agents: results,
    total: Number(countResult[0]?.count ?? 0),
    limit,
    offset,
  };
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
