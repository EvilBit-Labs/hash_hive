/**
 * Real-DB tests for U12: committed_keyspace_offset advance + reclaim resume
 * + the poison-task retry-count resolution carried from U11.
 *
 * The committed offset is an ABSOLUTE keyspace coordinate (workRange.start +
 * relative keyspaceProgress), so these tests use a non-zero workRange.start to
 * catch the absolute-vs-relative footgun the plan calls out.
 *
 * Runs under `just test-db`. Do NOT call client.end() — harness.test.ts owns
 * the shared client.
 */

import { agents, attacks, campaigns, hashLists, hashTypes, projects, tasks } from '@hashhive/shared'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { assignNextTask, reassignStaleTasks, updateTaskProgress } from '../../src/services/tasks.js'

const SLUG = 'tasks-resume-test-proj'
const MODE = 9_999_822
const START = 1000
const END = 5000

let projectId = 0
let agentAId = 0
let agentBId = 0
let attackId = 0
let campaignId = 0

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG))
  await db.delete(hashTypes).where(eq(hashTypes.hashcatMode, MODE))
}

async function seed(): Promise<void> {
  const [project] = await db.insert(projects).values({ name: SLUG, slug: SLUG }).returning()
  projectId = project!.id
  const [hashType] = await db
    .insert(hashTypes)
    .values({ name: 'resume-test', hashcatMode: MODE })
    .returning()
  const [hashList] = await db
    .insert(hashLists)
    .values({ projectId, name: 'resume-list', hashTypeId: hashType!.id, status: 'ready' })
    .returning()
  const [campaign] = await db
    .insert(campaigns)
    .values({
      name: 'resume-camp',
      projectId,
      hashListId: hashList!.id,
      priority: 1,
      status: 'running',
    })
    .returning()
  campaignId = campaign!.id
  const [attack] = await db.insert(attacks).values({ campaignId, projectId, mode: 0 }).returning()
  attackId = attack!.id
  const [a] = await db
    .insert(agents)
    .values({ name: 'resume-a', projectId, capabilities: { gpu: false }, status: 'online' })
    .returning()
  agentAId = a!.id
  const [b] = await db
    .insert(agents)
    .values({ name: 'resume-b', projectId, capabilities: { gpu: false }, status: 'online' })
    .returning()
  agentBId = b!.id
}

async function insertTask(): Promise<number> {
  const [task] = await db
    .insert(tasks)
    .values({
      attackId,
      campaignId,
      status: 'pending',
      workRange: { start: START, end: END, total: END - START },
      requiredCapabilities: { gpu: false },
    })
    .returning({ id: tasks.id })
  return task!.id
}

async function readTask(id: number) {
  const [row] = await db
    .select({
      status: tasks.status,
      agentId: tasks.agentId,
      workRange: tasks.workRange,
      committedOffset: tasks.committedKeyspaceOffset,
      retryCount: tasks.retryCount,
    })
    .from(tasks)
    .where(eq(tasks.id, id))
  return row!
}

async function expireLease(id: number): Promise<void> {
  await db.execute(
    sql`UPDATE tasks SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${id}`
  )
}

beforeEach(async () => {
  await cleanup()
  await seed()
})

afterAll(cleanup)

describe('U12 committed-offset advance', () => {
  it('advances committed_keyspace_offset to the ABSOLUTE coordinate (start + keyspaceProgress)', async () => {
    const id = await insertTask()
    await assignNextTask(agentAId)
    await updateTaskProgress(id, agentAId, {
      status: 'running',
      progress: { keyspaceProgress: 500 },
    })
    const row = await readTask(id)
    // absolute = workRange.start (1000) + relative keyspaceProgress (500) = 1500
    expect(Number(row.committedOffset)).toBe(START + 500)
  })

  it('keeps the committed offset monotonic across an out-of-order report (GREATEST)', async () => {
    const id = await insertTask()
    await assignNextTask(agentAId)
    await updateTaskProgress(id, agentAId, {
      status: 'running',
      progress: { keyspaceProgress: 800 },
    })
    await updateTaskProgress(id, agentAId, {
      status: 'running',
      progress: { keyspaceProgress: 300 },
    })
    const row = await readTask(id)
    expect(Number(row.committedOffset)).toBe(START + 800) // not regressed to 300
  })
})

describe('U12 reclaim resume', () => {
  it('re-pends a reclaimed task from the committed offset (absolute) and increments retry_count', async () => {
    const id = await insertTask()
    await assignNextTask(agentAId)
    await updateTaskProgress(id, agentAId, {
      status: 'running',
      progress: { keyspaceProgress: 500 },
    })
    expect((await readTask(id)).retryCount).toBe(0)

    await expireLease(id)
    await assignNextTask(agentBId) // B reclaims
    const row = await readTask(id)
    expect(row.agentId).toBe(agentBId)
    // workRange.start resumed to the absolute committed offset (1500), NOT 0 or START
    expect(Number((row.workRange as { start: number | string }).start)).toBe(START + 500)
    expect(row.retryCount).toBe(1) // reclaim counted a retry
  })

  it('resets retry_count to 0 when the resumed agent advances the watermark', async () => {
    const id = await insertTask()
    await assignNextTask(agentAId)
    await updateTaskProgress(id, agentAId, {
      status: 'running',
      progress: { keyspaceProgress: 500 },
    })
    await expireLease(id)
    await assignNextTask(agentBId)
    const reclaimed = await readTask(id)
    expect(reclaimed.retryCount).toBe(1)
    // Coordinate-frame regression guard: on reclaim, work_range.start rebased to
    // the committed offset AND progress.keyspaceProgress reset to 0. B then
    // reports a SMALL relative value (100) — BELOW A's last report (500). With
    // the reset, 100 > 0 so the watermark advances and retry_count resets. Before
    // the fix this compared 100 < 500 (stale) and the legitimate resume was
    // wrongly penalized (lease not extended, retry not reset).
    expect(Number(reclaimed.committedOffset)).toBe(START + 500)
    await updateTaskProgress(id, agentBId, {
      status: 'running',
      progress: { keyspaceProgress: 100 },
    })
    expect((await readTask(id)).retryCount).toBe(0)
  })
})

describe('U12 poison-task protection', () => {
  it('stops reclaiming and terminally fails a task reclaimed MAX_RETRIES times without progress', async () => {
    const id = await insertTask()
    // Claim then expire-and-reclaim repeatedly with NO progress reports.
    await assignNextTask(agentAId)
    for (let i = 0; i < 3; i++) {
      await expireLease(id)
      await assignNextTask(i % 2 === 0 ? agentBId : agentAId)
    }
    const beforeFail = await readTask(id)
    expect(beforeFail.retryCount).toBe(3) // MAX_RETRIES

    // 4th attempt: the CTE must NOT reclaim it (retry_count >= MAX_RETRIES).
    await expireLease(id)
    await assignNextTask(agentBId)
    const stillStuck = await readTask(id)
    expect(stillStuck.retryCount).toBe(3) // not incremented further; not reclaimed

    // The backstop terminally fails it.
    await reassignStaleTasks()
    expect((await readTask(id)).status).toBe('failed')
  })
})
