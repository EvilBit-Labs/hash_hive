/**
 * Real-DB tests for U13 split-on-claim: a claimed range larger than the agent's
 * target-duration parcel is trimmed to the parcel and the remainder re-pended,
 * atomically. Verifies the parcel math (per-agent EWMA rate), no-split when the
 * range already fits, cold-start (no benchmark -> DEFAULT, never BigInt(NaN)),
 * and bigint-scale precision.
 *
 * Runs under `just test-db`. Do NOT call client.end() — harness.test.ts owns
 * the shared client.
 */

import {
  agentBenchmarks,
  agents,
  attacks,
  campaigns,
  hashLists,
  hashTypes,
  projects,
  tasks,
} from '@hashhive/shared'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { assignNextTask } from '../../src/services/tasks.js'

const SLUG = 'tasks-split-test-proj'
const MODE = 9_999_833

let projectId = 0
let attackId = 0
let campaignId = 0

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG))
  await db.delete(hashTypes).where(eq(hashTypes.hashcatMode, MODE))
}

async function seedAgent(name: string, observedSpeedHs: number | null): Promise<number> {
  const [agent] = await db
    .insert(agents)
    .values({
      name,
      projectId,
      capabilities: { gpu: false, hashModes: [MODE] },
      status: 'online',
    })
    .returning({ id: agents.id })
  if (observedSpeedHs !== null) {
    await db.insert(agentBenchmarks).values({
      agentId: agent!.id,
      hashcatMode: MODE,
      hashType: 'split-test',
      speedHs: observedSpeedHs,
      observedSpeedHs,
      deviceName: 'test-gpu',
    })
  }
  return agent!.id
}

async function insertTask(total: number | string): Promise<number> {
  const [task] = await db
    .insert(tasks)
    .values({
      attackId,
      campaignId,
      status: 'pending',
      workRange: { start: 0, end: total, total },
      requiredCapabilities: { gpu: false, hashcatMode: MODE },
    })
    .returning({ id: tasks.id })
  return task!.id
}

async function pendingRemainders(): Promise<Array<{ workRange: unknown }>> {
  return db
    .select({ workRange: tasks.workRange })
    .from(tasks)
    .where(and(eq(tasks.attackId, attackId), eq(tasks.status, 'pending')))
}

beforeEach(async () => {
  await cleanup()
  const [project] = await db.insert(projects).values({ name: SLUG, slug: SLUG }).returning()
  projectId = project!.id
  const [hashType] = await db
    .insert(hashTypes)
    .values({ name: 'split', hashcatMode: MODE })
    .returning()
  const [hashList] = await db
    .insert(hashLists)
    .values({ projectId, name: 'split-list', hashTypeId: hashType!.id, status: 'ready' })
    .returning()
  const [campaign] = await db
    .insert(campaigns)
    .values({
      name: 'split-camp',
      projectId,
      hashListId: hashList!.id,
      priority: 1,
      status: 'running',
    })
    .returning()
  campaignId = campaign!.id
  const [attack] = await db.insert(attacks).values({ campaignId, projectId, mode: 0 }).returning()
  attackId = attack!.id
})

afterAll(cleanup)

describe('U13 split-on-claim', () => {
  it('trims an oversized claim to a target-duration parcel and re-pends the remainder', async () => {
    // 100k H/s * 300s = 30,000,000 parcel; range is 100,000,000 -> split.
    const agentId = await seedAgent('fast', 100_000)
    const id = await insertTask(100_000_000)
    const claimed = await assignNextTask(agentId)
    expect(claimed).not.toBeNull()
    expect(claimed!.id).toBe(id)
    const wr = claimed!.workRange as { start: number | string; end: number | string }
    expect(Number(wr.start)).toBe(0)
    expect(Number(wr.end)).toBe(30_000_000) // parcel = rate * target

    const remainders = await pendingRemainders()
    expect(remainders).toHaveLength(1)
    const rem = remainders[0]!.workRange as { start: number | string; end: number | string }
    expect(Number(rem.start)).toBe(30_000_000) // contiguous, no overlap/gap
    expect(Number(rem.end)).toBe(100_000_000)
  })

  it('gives a slower agent a smaller parcel on the same range', async () => {
    const agentId = await seedAgent('slow', 10_000) // 10k * 300 = 3,000,000
    await insertTask(100_000_000)
    const claimed = await assignNextTask(agentId)
    const wr = claimed!.workRange as { end: number | string }
    expect(Number(wr.end)).toBe(3_000_000)
  })

  it('claims a range already at/under the parcel size whole, with no split', async () => {
    const agentId = await seedAgent('fast', 100_000) // parcel 30M
    await insertTask(1000) // well under the parcel
    const claimed = await assignNextTask(agentId)
    const wr = claimed!.workRange as { start: number | string; end: number | string }
    expect(Number(wr.end)).toBe(1000)
    expect(await pendingRemainders()).toHaveLength(0) // no remainder created
  })

  it('cold start (no benchmark) sizes from DEFAULT_AGENT_SPEED_HS, never BigInt(NaN) or 0', async () => {
    const agentId = await seedAgent('cold', null) // no benchmark row
    await insertTask(100_000_000_000) // huge so the DEFAULT-rate parcel is < remaining
    const claimed = await assignNextTask(agentId)
    expect(claimed).not.toBeNull()
    const wr = claimed!.workRange as { start: number | string; end: number | string }
    // DEFAULT 1,000,000 H/s * 300 = 300,000,000, clamped to MAX_CHUNK_SIZE 1e9 -> 3e8
    expect(Number(wr.end)).toBe(300_000_000)
    expect(Number(wr.start)).toBe(0)
  })

  // The MAX_CHUNKS_PER_ATTACK cap-hit branch (assign whole range, no split) is
  // covered in the mocked lane (tasks.test.ts) — exercising it for real needs
  // 100k+ rows, whose cascade cleanup is too slow/racy for the shared db lane.

  it('rolls back the trim and assigns the full range when the remainder insert fails (no lost keyspace)', async () => {
    const agentId = await seedAgent('fast', 100_000) // parcel 30,000,000
    const id = await insertTask(100_000_000) // remainder would start at 30,000,000
    // Inject a fault: reject the remainder INSERT (a new pending task starting at
    // the parcel boundary). The trim+remainder run in one transaction, so this
    // forces the trim to roll back.
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION _reject_split_remainder() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'pending' AND NEW.work_range->>'start' = '30000000' THEN
          RAISE EXCEPTION 'injected split remainder failure';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
    `)
    await db.execute(
      sql`CREATE TRIGGER _reject_split BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION _reject_split_remainder()`
    )
    try {
      const claimed = await assignNextTask(agentId)
      // The claim still succeeds (the CTE committed before the split); the split
      // rolled back atomically, so the task keeps its FULL range and no orphan
      // remainder exists — no keyspace lost.
      expect(claimed).not.toBeNull()
      expect(claimed!.id).toBe(id)
      const wr = claimed!.workRange as { start: number | string; end: number | string }
      expect(Number(wr.end)).toBe(100_000_000) // full range retained (trim rolled back)
      expect(await pendingRemainders()).toHaveLength(0) // no orphan remainder created
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS _reject_split ON tasks`)
      await db.execute(sql`DROP FUNCTION IF EXISTS _reject_split_remainder()`)
    }
  })

  it('splits a bigint-scale keyspace without precision loss', async () => {
    const big = '90071992547409920' // > Number.MAX_SAFE_INTEGER (9007199254740991)
    const agentId = await seedAgent('fast', 100_000) // parcel 30,000,000
    await insertTask(big)
    const claimed = await assignNextTask(agentId)
    const wr = claimed!.workRange as { end: number | string }
    expect(String(wr.end)).toBe('30000000')
    const remainders = await pendingRemainders()
    const rem = remainders[0]!.workRange as { start: number | string; end: number | string }
    expect(String(rem.start)).toBe('30000000')
    expect(String(rem.end)).toBe(big) // exact bigint preserved as decimal string
  })
})
