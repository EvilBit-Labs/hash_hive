/**
 * Real-DB tests for the agent advanced-config storage layer (#104, U2):
 * the `agents.config` jsonb column and the `fleet_agent_config` singleton.
 * A mocked db cannot prove the singleton CHECK constraint or the jsonb
 * round-trip — the DDL itself is the thing under test.
 */

import { agents, fleetAgentConfig, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

import { db } from '../../src/db/index.js'

const SLUG = 'agent-config-u2-test'
let projectId = 0
let agentId = 0

async function cleanup(): Promise<void> {
  // Deleting the project cascades to its agents.
  await db.delete(projects).where(eq(projects.slug, SLUG))
  await db.delete(fleetAgentConfig).where(inArray(fleetAgentConfig.id, [1, 2]))
}

beforeAll(async () => {
  await cleanup()
  const [project] = await db
    .insert(projects)
    .values({ name: 'Config test', slug: SLUG })
    .returning()
  projectId = project!.id
  const [agent] = await db.insert(agents).values({ name: 'cfg-agent', projectId }).returning()
  agentId = agent!.id
})

afterAll(async () => {
  // Do NOT call client.end() — harness.test.ts owns the shared drizzle pool.
  await cleanup()
})

describe('agents.config column', () => {
  it('round-trips a per-rig config jsonb', async () => {
    const config = {
      tuning: { hashcat: { workloadProfile: 3 } },
      errorWhitelist: ['No hashes loaded'],
    }
    await db.update(agents).set({ config }).where(eq(agents.id, agentId))
    const [row] = await db
      .select({ config: agents.config })
      .from(agents)
      .where(eq(agents.id, agentId))
    expect(row!.config).toEqual(config)
  })

  it('defaults to an empty object', async () => {
    const [agent] = await db
      .insert(agents)
      .values({ name: 'cfg-agent-default', projectId })
      .returning()
    expect(agent!.config).toEqual({})
  })
})

describe('fleet_agent_config singleton', () => {
  it('stores and reads the id=1 row', async () => {
    const config = { tuning: { hashcat: { workloadProfile: 2 } } }
    await db
      .insert(fleetAgentConfig)
      .values({ id: 1, config })
      .onConflictDoUpdate({ target: fleetAgentConfig.id, set: { config } })
    const [row] = await db.select().from(fleetAgentConfig).where(eq(fleetAgentConfig.id, 1))
    expect(row!.config).toEqual(config)
  })

  it('rejects a non-singleton row via the id=1 CHECK', async () => {
    let rejected = false
    try {
      await db.insert(fleetAgentConfig).values({ id: 2, config: {} })
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })
})
