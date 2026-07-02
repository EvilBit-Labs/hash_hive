/**
 * Real-DB tests for agent retirement (issue #106 U8): the `retired`
 * terminal status, fleet-list exclusion, the single-transaction
 * status-flip + task-release, the heartbeat un-retire guard, history
 * preservation, and the `retired` audit event. These prove SQL-level
 * behavior the mocked default lane cannot — the guarded UPDATEs, the
 * atomicity of the retire transaction, and real Postgres row state after
 * a heartbeat.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). cleanupSeed()
 * in afterAll keeps runs idempotent and order-independent.
 *
 * NOTE: do NOT call client.end() here — harness.test.ts owns the shared
 * drizzle client lifecycle. All db-lane files share the same client.
 */

import {
  agentBenchmarks,
  agentErrors,
  agents,
  attacks,
  auditLogs,
  campaigns,
  hashLists,
  hashTypes,
  projects,
  tasks,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { listAgents, retireAgent, updateAgent } from '../../src/services/agents.js'
import { processHeartbeat } from '../../src/services/agents/heartbeat.js'
import { assignNextTask } from '../../src/services/tasks.js'

const TEST_SLUG = 'agents-retire-test-proj'
const HASHCAT_MODE = 9_999_845 // unique to this test file

interface SeedCtx {
  projectId: number
  campaignId: number
  attackId: number
}

let ctx: SeedCtx

async function insertAgent(name: string): Promise<number> {
  const [row] = await db
    .insert(agents)
    .values({ name, projectId: ctx.projectId, status: 'online' })
    .returning({ id: agents.id })
  return row!.id
}

async function insertTask(overrides: { agentId: number | null; status: string }): Promise<number> {
  const [row] = await db
    .insert(tasks)
    .values({
      attackId: ctx.attackId,
      campaignId: ctx.campaignId,
      agentId: overrides.agentId,
      status: overrides.status,
      workRange: { start: 0, end: 100, total: 100 },
    })
    .returning({ id: tasks.id })
  return row!.id
}

async function readAgent(id: number) {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1)
  return row
}

async function readTask(id: number) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
  return row
}

async function cleanupSeed(): Promise<void> {
  // Project cascade removes hashLists/campaigns/attacks/tasks/agents in
  // one delete. Audit logs set project_id to null on project delete
  // (onDelete: 'set null'), so clean those up explicitly by entityType.
  await db.delete(auditLogs).where(eq(auditLogs.entityType, 'agent'))
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG))
  await db.delete(hashTypes).where(eq(hashTypes.hashcatMode, HASHCAT_MODE))
}

beforeAll(async () => {
  await cleanupSeed()
  const [project] = await db
    .insert(projects)
    .values({ name: TEST_SLUG, slug: TEST_SLUG })
    .returning({ id: projects.id })
  const projectId = project!.id
  const [hashType] = await db
    .insert(hashTypes)
    .values({ name: 'agents-retire-test', hashcatMode: HASHCAT_MODE })
    .returning({ id: hashTypes.id })
  const [hashList] = await db
    .insert(hashLists)
    .values({
      projectId,
      name: 'agents-retire-test-list',
      hashTypeId: hashType!.id,
      status: 'ready',
    })
    .returning({ id: hashLists.id })
  const [campaign] = await db
    .insert(campaigns)
    .values({
      projectId,
      name: 'agents-retire-test-campaign',
      hashListId: hashList!.id,
      priority: 5,
      status: 'draft',
    })
    .returning({ id: campaigns.id })
  const [attack] = await db
    .insert(attacks)
    .values({
      campaignId: campaign!.id,
      projectId,
      mode: 3,
      advancedConfiguration: { mask: '?d?d' },
    })
    .returning({ id: attacks.id })
  ctx = { projectId, campaignId: campaign!.id, attackId: attack!.id }
})

afterAll(cleanupSeed)

const SYSTEM_ACTOR = { actorType: 'system' as const, actorId: null }

// ─── Happy path + fleet exclusion (R7, R10) ──────────────────────────

describe('retireAgent: happy path + fleet exclusion (U8, R7, R10)', () => {
  it('retires an idle agent and excludes it from the default listAgents view', async () => {
    const agentId = await insertAgent('retire-idle')

    const result = await retireAgent(agentId, ctx.projectId, SYSTEM_ACTOR)
    expect(result.kind).toBe('retired')
    if (result.kind !== 'retired') throw new Error('unreachable')
    expect(result.releasedTaskIds).toEqual([])

    const row = await readAgent(agentId)
    expect(row?.status).toBe('retired')

    const { agents: defaultList } = await listAgents({ projectId: ctx.projectId })
    expect(defaultList.map((a) => a.id)).not.toContain(agentId)

    // Explicit status=retired filter still reveals it (R10's "explicit
    // filter to reveal them" escape hatch, reusing the existing status
    // query param instead of a second boolean flag).
    const { agents: retiredList } = await listAgents({
      projectId: ctx.projectId,
      status: 'retired',
    })
    expect(retiredList.map((a) => a.id)).toContain(agentId)
  })

  it('reports not_found for a missing or cross-project agent id', async () => {
    const result = await retireAgent(999_999_999, ctx.projectId, SYSTEM_ACTOR)
    expect(result.kind).toBe('not_found')

    const agentId = await insertAgent('retire-cross-project')
    const crossProjectResult = await retireAgent(agentId, ctx.projectId + 100_000, SYSTEM_ACTOR)
    expect(crossProjectResult.kind).toBe('not_found')
    expect((await readAgent(agentId))?.status).toBe('online')
  })

  it('is idempotent: retiring an already-retired agent reports already_retired', async () => {
    const agentId = await insertAgent('retire-twice')
    const first = await retireAgent(agentId, ctx.projectId, SYSTEM_ACTOR)
    expect(first.kind).toBe('retired')

    const second = await retireAgent(agentId, ctx.projectId, SYSTEM_ACTOR)
    expect(second.kind).toBe('already_retired')
    expect((await readAgent(agentId))?.status).toBe('retired')
  })
})

// ─── Task release (R8) ────────────────────────────────────────────────

describe('retireAgent: releases in-flight tasks (U8, R8)', () => {
  it('returns one assigned and one running task to pending with agent_id cleared', async () => {
    const agentId = await insertAgent('retire-with-tasks')
    const assignedTaskId = await insertTask({ agentId, status: 'assigned' })
    const runningTaskId = await insertTask({ agentId, status: 'running' })
    // A terminal task belonging to the agent must NOT be touched.
    const completedTaskId = await insertTask({ agentId, status: 'exhausted' })

    const result = await retireAgent(agentId, ctx.projectId, SYSTEM_ACTOR)
    expect(result.kind).toBe('retired')
    if (result.kind !== 'retired') throw new Error('unreachable')
    expect(new Set(result.releasedTaskIds)).toEqual(new Set([assignedTaskId, runningTaskId]))

    const assignedAfter = await readTask(assignedTaskId)
    expect(assignedAfter?.status).toBe('pending')
    expect(assignedAfter?.agentId).toBeNull()

    const runningAfter = await readTask(runningTaskId)
    expect(runningAfter?.status).toBe('pending')
    expect(runningAfter?.agentId).toBeNull()

    // Untouched: still exhausted, still attributed to the retired agent
    // (history preservation, R9).
    const completedAfter = await readTask(completedTaskId)
    expect(completedAfter?.status).toBe('exhausted')
    expect(completedAfter?.agentId).toBe(agentId)
  })

  it('a retired agent with released tasks runs no further work', async () => {
    const agentId = await insertAgent('retire-no-more-work')
    await insertTask({ agentId, status: 'assigned' })
    await retireAgent(agentId, ctx.projectId, SYSTEM_ACTOR)

    const claimed = await assignNextTask(agentId)
    expect(claimed).toBeNull()
  })
})

// ─── Heartbeat un-retire guard (R8, R9 + plan Risk: heartbeat overwrite) ──

describe('retireAgent: heartbeat cannot un-retire (U8)', () => {
  it('a heartbeat from a retired agent leaves status unchanged and assigns no work', async () => {
    const agentId = await insertAgent('retire-heartbeat-guard')
    await retireAgent(agentId, ctx.projectId, SYSTEM_ACTOR)
    expect((await readAgent(agentId))?.status).toBe('retired')

    // Simulate a still-running rig that hasn't been told to stop: it keeps
    // polling and self-reporting 'online'. Without the guard this would
    // flip the row back to 'online' and make the agent claim-eligible.
    const heartbeatResult = await processHeartbeat(agentId, { status: 'online' })

    const row = await readAgent(agentId)
    expect(row?.status).toBe('retired')
    expect(heartbeatResult.hasHighPriorityTasks).toBe(false)

    // The claim path independently refuses a non-online/benchmarked agent,
    // but re-assert it here so a future relaxation of that guard is still
    // caught by this test.
    const claimed = await assignNextTask(agentId)
    expect(claimed).toBeNull()
  })
})

// ─── History preservation (R9) ───────────────────────────────────────

describe('retireAgent: preserves history (U8, R9)', () => {
  it('keeps task history, benchmarks, and errors attributed after retirement', async () => {
    const agentId = await insertAgent('retire-preserves-history')
    const historicalTaskId = await insertTask({ agentId, status: 'exhausted' })

    await db.insert(agentBenchmarks).values({
      agentId,
      hashcatMode: HASHCAT_MODE,
      hashType: 'agents-retire-test',
      speedHs: 12_345,
      deviceName: 'test-gpu',
    })
    await db.insert(agentErrors).values({
      agentId,
      severity: 'warning',
      message: 'pre-retirement error',
      context: {},
    })

    await retireAgent(agentId, ctx.projectId, SYSTEM_ACTOR)

    const agentRow = await readAgent(agentId)
    expect(agentRow).toBeDefined()
    expect(agentRow?.status).toBe('retired')

    const taskRow = await readTask(historicalTaskId)
    expect(taskRow?.agentId).toBe(agentId)
    expect(taskRow?.status).toBe('exhausted')

    const benchmarkRows = await db
      .select()
      .from(agentBenchmarks)
      .where(eq(agentBenchmarks.agentId, agentId))
    expect(benchmarkRows.length).toBe(1)

    const errorRows = await db.select().from(agentErrors).where(eq(agentErrors.agentId, agentId))
    expect(errorRows.length).toBe(1)
  })
})

// ─── Audit event (R13 vocab, R8/R9 lifecycle) ────────────────────────

describe('retireAgent: records a retired audit event (U8)', () => {
  it('inserts one audit_logs row with action=retired for the agent', async () => {
    const agentId = await insertAgent('retire-audit')
    await retireAgent(agentId, ctx.projectId, SYSTEM_ACTOR)

    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'agent'), eq(auditLogs.entityId, agentId)))
    expect(rows.length).toBe(1)
    expect(rows[0]?.action).toBe('retired')
    expect(rows[0]?.projectId).toBe(ctx.projectId)
  })
})

// ─── F4 (issue #106 code review) — retired agents are immutable via PATCH ──

describe('updateAgent: a retired agent is immutable via the generic PATCH path (F4)', () => {
  it('reports retired and leaves the row untouched when un-retiring via status', async () => {
    const agentId = await insertAgent('update-retired-agent')
    const retireResult = await retireAgent(agentId, ctx.projectId, SYSTEM_ACTOR)
    expect(retireResult.kind).toBe('retired')

    // A contributor/admin attempting to PATCH status back to 'online'
    // through the generic update path must be refused -- retirement has
    // no restore path (ADR-0019 / R9).
    const result = await updateAgent(agentId, { status: 'online' }, ctx.projectId, SYSTEM_ACTOR)
    expect(result.kind).toBe('retired')

    const row = await readAgent(agentId)
    expect(row?.status).toBe('retired')
  })

  it('also refuses a name-only edit on a retired agent', async () => {
    const agentId = await insertAgent('update-retired-agent-name')
    await retireAgent(agentId, ctx.projectId, SYSTEM_ACTOR)

    const result = await updateAgent(agentId, { name: 'renamed' }, ctx.projectId, SYSTEM_ACTOR)
    expect(result.kind).toBe('retired')

    const row = await readAgent(agentId)
    expect(row?.name).toBe('update-retired-agent-name')
  })

  it('still updates a non-retired agent normally', async () => {
    const agentId = await insertAgent('update-online-agent')

    const result = await updateAgent(
      agentId,
      { name: 'renamed-online' },
      ctx.projectId,
      SYSTEM_ACTOR
    )
    expect(result.kind).toBe('updated')

    const row = await readAgent(agentId)
    expect(row?.name).toBe('renamed-online')
  })

  it('reports not_found for a missing or cross-project agent id', async () => {
    const missing = await updateAgent(999_999_999, { name: 'x' }, ctx.projectId, SYSTEM_ACTOR)
    expect(missing.kind).toBe('not_found')

    const agentId = await insertAgent('update-cross-project-agent')
    const crossProject = await updateAgent(
      agentId,
      { name: 'x' },
      ctx.projectId + 100_000,
      SYSTEM_ACTOR
    )
    expect(crossProject.kind).toBe('not_found')
  })
})
