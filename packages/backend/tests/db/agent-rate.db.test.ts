/**
 * Real-DB test for the observed-rate EWMA (U6).
 *
 * Proves the atomic `UPDATE ... SET observed_speed_hs = ROUND(... COALESCE ...)`
 * actually runs against Postgres and that cold-start seeding works — behaviour
 * a mocked db cannot verify (the SQL expression itself is the thing under test).
 */

import { agentBenchmarks, agents, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { updateAgentObservedRate } from '../../src/services/agent-rate.js'

const SLUG = 'agent-rate-ewma-test'
const MODE = 1000
const SEED_SPEED = 800_000

let agentId = 0
let projectId = 0

async function cleanup(): Promise<void> {
  // Deleting the project cascades to agents and their benchmark rows.
  await db.delete(projects).where(eq(projects.slug, SLUG))
}

beforeAll(async () => {
  await cleanup()
  const [project] = await db.insert(projects).values({ name: 'EWMA test', slug: SLUG }).returning()
  projectId = project!.id
  const [agent] = await db.insert(agents).values({ name: 'ewma-agent', projectId }).returning()
  agentId = agent!.id
  await db.insert(agentBenchmarks).values({
    agentId,
    hashcatMode: MODE,
    hashType: 'test',
    speedHs: SEED_SPEED,
    deviceName: 'test-gpu',
    // observedSpeedHs intentionally left null to exercise cold-start seeding.
  })
})

afterAll(async () => {
  // Do NOT call client.end() here — harness.test.ts owns the shared drizzle
  // client lifecycle. Ending it from this file would break the other db tests.
  await cleanup()
})

async function readObserved(): Promise<number | null> {
  const [row] = await db
    .select({ observed: agentBenchmarks.observedSpeedHs })
    .from(agentBenchmarks)
    .where(and(eq(agentBenchmarks.agentId, agentId), eq(agentBenchmarks.hashcatMode, MODE)))
  return row?.observed ?? null
}

describe('updateAgentObservedRate (real DB)', () => {
  it('cold-starts: seeds the EWMA from speed_hs, never from zero', async () => {
    const sample = 1_000_000
    await updateAgentObservedRate(agentId, MODE, sample)
    const observed = await readObserved()
    // alpha*sample + (1-alpha)*COALESCE(null, speed_hs) = 0.125*1e6 + 0.875*8e5
    const expected = Math.round(0.125 * sample + 0.875 * SEED_SPEED)
    expect(observed).toBe(expected)
    expect(observed).toBeGreaterThan(0)
  })

  it('moves the EWMA toward a new sample by ~alpha on the next report', async () => {
    const prev = (await readObserved())!
    const sample = 2_000_000
    await updateAgentObservedRate(agentId, MODE, sample)
    const observed = (await readObserved())!
    expect(observed).toBe(Math.round(0.125 * sample + 0.875 * prev))
    // Nowhere near the outlier sample.
    expect(observed).toBeLessThan(prev + (sample - prev) * 0.25)
  })

  it('no-ops safely when no benchmark row exists for the (agent, mode)', async () => {
    // A mode with no benchmark row: UPDATE matches zero rows, must not throw.
    await updateAgentObservedRate(agentId, 9999, 1_234_567)
    const [missing] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(agentBenchmarks)
      .where(and(eq(agentBenchmarks.agentId, agentId), eq(agentBenchmarks.hashcatMode, 9999)))
    expect(missing?.c).toBe(0)
  })
})
