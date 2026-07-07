/**
 * Real-DB tests for the campaign ETA rollup (issue #100 U1): a read-time sum
 * of per-attack `estimateSecondsRemaining` over a campaign's non-terminal
 * attacks, returning the discriminated `CampaignEta` state.
 *
 * Covers the precedence ladder end to end against real attack/task/agent/
 * benchmark rows: AE5 (sum, not max), AE4 (partial rollup -> lower_bound),
 * AE2 (no throughput -> estimating), AE3 (paused), no active agents ->
 * no_agents, AE7 (all-terminal -> complete, never "0h"), and R11 (a
 * malformed/non-positive agent speed cannot poison the sum).
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
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import {
  getArchivedAttackIds,
  getCampaignEta,
  getCampaignEtasBatch,
} from '../../src/services/campaign-eta-rollup.js'

const SLUG = 'campaign-eta-rollup-test-proj'
const MODE = 9_999_881

let projectId = 0
let hashListId = 0

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG))
  await db.delete(hashTypes).where(eq(hashTypes.hashcatMode, MODE))
}

async function seedCampaign(status: string): Promise<number> {
  const [campaign] = await db
    .insert(campaigns)
    .values({ name: `camp-${status}-${Math.random()}`, projectId, hashListId, priority: 1, status })
    .returning({ id: campaigns.id })
  return campaign!.id
}

async function seedAttack(campaignId: number, keyspace: string | null): Promise<number> {
  const [attack] = await db
    .insert(attacks)
    .values({ campaignId, projectId, mode: MODE, keyspace })
    .returning({ id: attacks.id })
  return attack!.id
}

async function seedAgent(status: string, name: string): Promise<number> {
  const [agent] = await db
    .insert(agents)
    .values({ name, projectId, status })
    .returning({ id: agents.id })
  return agent!.id
}

async function seedBenchmark(agentId: number, speedHs: number): Promise<void> {
  await db
    .insert(agentBenchmarks)
    .values({ agentId, hashcatMode: MODE, hashType: 'eta-rollup', speedHs, deviceName: 'test-gpu' })
}

/** A task claimed by an agent — what `hasActiveAgents` keys off. */
async function seedActiveTask(
  attackId: number,
  campaignId: number,
  agentId: number,
  status: 'pending' | 'assigned' | 'running' = 'running'
): Promise<void> {
  await db
    .insert(tasks)
    .values({ attackId, campaignId, agentId, status, workRange: {}, progress: {} })
}

/** A terminal, unassigned task — pushes its attack to a terminal status. */
async function seedTerminalTask(attackId: number, campaignId: number): Promise<void> {
  await db
    .insert(tasks)
    .values({ attackId, campaignId, status: 'completed', workRange: {}, progress: {} })
}

beforeEach(async () => {
  await cleanup()
  const [project] = await db.insert(projects).values({ name: SLUG, slug: SLUG }).returning()
  projectId = project!.id
  const [hashType] = await db
    .insert(hashTypes)
    .values({ name: 'eta-rollup', hashcatMode: MODE })
    .returning()
  const [hashList] = await db
    .insert(hashLists)
    .values({ projectId, name: 'eta-rollup-list', hashTypeId: hashType!.id, status: 'ready' })
    .returning()
  hashListId = hashList!.id
})

afterAll(cleanup)

describe('campaign ETA rollup (#100 U1)', () => {
  it('AE5: sums two computable non-terminal attacks (not the max)', async () => {
    const campaignId = await seedCampaign('running')
    const agentId = await seedAgent('online', 'fast')
    await seedBenchmark(agentId, 100_000) // 100k H/s

    const attackA = await seedAttack(campaignId, '100000000') // 100M -> 1000s a-priori
    await seedAttack(campaignId, '200000000') // 200M -> 2000s a-priori
    // One active task anywhere in the campaign satisfies `hasActiveAgents`;
    // zero progress reported, so it does not shrink either attack's ETA.
    await seedActiveTask(attackA, campaignId, agentId, 'running')

    const eta = await getCampaignEta(campaignId)
    expect(eta).toEqual({ state: 'ready', seconds: 3000 })
    expect(eta).not.toEqual({ state: 'ready', seconds: 2000 }) // guards against max() instead of sum()
  })

  it('AE4: one computable + one keyspace-pending attack -> lower_bound with pendingAttacks=1', async () => {
    const campaignId = await seedCampaign('running')
    const agentId = await seedAgent('online', 'fast')
    await seedBenchmark(agentId, 100_000)

    const computable = await seedAttack(campaignId, '100000000') // 1000s
    await seedAttack(campaignId, null) // keyspace still being computed
    await seedActiveTask(computable, campaignId, agentId, 'running')

    const eta = await getCampaignEta(campaignId)
    expect(eta).toEqual({ state: 'lower_bound', seconds: 1000, pendingAttacks: 1 })
  })

  it('AE2: no throughput yet -> estimating', async () => {
    const campaignId = await seedCampaign('running')
    const agentId = await seedAgent('online', 'benchless') // no benchmark row for MODE
    const attackId = await seedAttack(campaignId, '100000000')
    // Active task present (so no_agents does not pre-empt this case), but no
    // fleet benchmark exists yet -> estimateSecondsRemaining resolves to null.
    await seedActiveTask(attackId, campaignId, agentId, 'pending')

    const eta = await getCampaignEta(campaignId)
    expect(eta).toEqual({ state: 'estimating' })
  })

  it('AE3: paused campaign -> paused, regardless of computable attacks', async () => {
    const campaignId = await seedCampaign('paused')
    const agentId = await seedAgent('online', 'fast')
    await seedBenchmark(agentId, 100_000)
    const attackId = await seedAttack(campaignId, '100000000')
    await seedActiveTask(attackId, campaignId, agentId, 'running')

    const eta = await getCampaignEta(campaignId)
    expect(eta).toEqual({ state: 'paused' })
  })

  it('no active agents assigned -> no_agents', async () => {
    const campaignId = await seedCampaign('running')
    const agentId = await seedAgent('online', 'fast')
    await seedBenchmark(agentId, 100_000)
    // Non-terminal attack (no tasks -> derives to 'pending'), but nobody has
    // an active task claimed on this campaign.
    await seedAttack(campaignId, '100000000')

    const eta = await getCampaignEta(campaignId)
    expect(eta).toEqual({ state: 'no_agents' })
  })

  it('AE7: zero non-terminal attacks -> complete, never a computed 0h', async () => {
    const campaignId = await seedCampaign('running')
    const attackId = await seedAttack(campaignId, '100000000')
    // Every task for the attack is terminal -> attack status 'exhausted'
    // (campaign is 'running', not 'completed') -> zero non-terminal attacks.
    await seedTerminalTask(attackId, campaignId)

    const eta = await getCampaignEta(campaignId)
    expect(eta).toEqual({ state: 'complete' })
  })

  it('R11: a malformed/non-positive agent speed is excluded from the sum', async () => {
    const campaignId = await seedCampaign('running')
    const validAgent = await seedAgent('online', 'valid')
    await seedBenchmark(validAgent, 100_000) // 100k H/s
    const malformedAgent = await seedAgent('online', 'malformed')
    await seedBenchmark(malformedAgent, -50) // non-positive -> must be dropped

    const attackId = await seedAttack(campaignId, '100000000') // 100M
    await seedActiveTask(attackId, campaignId, validAgent, 'running')

    const eta = await getCampaignEta(campaignId)
    // If the malformed speed contributed, the fleet rate would be 99,950 H/s
    // and the ETA would differ (and could even go negative/NaN territory for
    // more extreme malformed values). Only the valid 100k H/s speed may count.
    expect(eta).toEqual({ state: 'ready', seconds: 1000 })
  })

  it('code review fix (issue #100 R1): excludes an archived non-terminal attack from the sum', async () => {
    const campaignId = await seedCampaign('running')
    const agentId = await seedAgent('online', 'fast')
    await seedBenchmark(agentId, 100_000) // 100k H/s

    const activeAttack = await seedAttack(campaignId, '100000000') // 100M -> 1000s
    await seedActiveTask(activeAttack, campaignId, agentId, 'running')

    // Archived sibling: non-terminal (no tasks -> would derive 'pending')
    // with a keyspace that WOULD add 2000s to the sum if it leaked in.
    // Mirrors attack-mode-consistency.db.test.ts's archived-sibling case:
    // an archived row must also be permanent
    // (attacks_archive_consistency_chk).
    await db
      .insert(attacks)
      .values({
        campaignId,
        projectId,
        mode: MODE,
        keyspace: '200000000',
        isPermanent: true,
        archivedAt: new Date(),
      })
      .returning({ id: attacks.id })

    const eta = await getCampaignEta(campaignId)
    // If the archived attack's estimate leaked into the sum, this would be
    // 3000s (1000 + 2000) instead of just the active attack's 1000s.
    expect(eta).toEqual({ state: 'ready', seconds: 1000 })
  })

  it('getCampaignEtasBatch computes multiple campaigns in one pass without a per-campaign query cascade', async () => {
    const agentId = await seedAgent('online', 'fast')
    await seedBenchmark(agentId, 100_000)

    const readyCampaign = await seedCampaign('running')
    const readyAttack = await seedAttack(readyCampaign, '100000000')
    await seedActiveTask(readyAttack, readyCampaign, agentId, 'running')

    const pausedCampaign = await seedCampaign('paused')
    const pausedAttack = await seedAttack(pausedCampaign, '100000000')
    await seedActiveTask(pausedAttack, pausedCampaign, agentId, 'running')

    const results = await getCampaignEtasBatch([readyCampaign, pausedCampaign])
    expect(results.get(readyCampaign)).toEqual({ state: 'ready', seconds: 1000 })
    expect(results.get(pausedCampaign)).toEqual({ state: 'paused' })
  })

  it('getArchivedAttackIds (issue #100 R1): returns only archived attack ids for the campaign, used by the detail route to filter the rollup input', async () => {
    const campaignId = await seedCampaign('running')
    const activeAttack = await seedAttack(campaignId, '100000000')
    const [archived] = await db
      .insert(attacks)
      .values({
        campaignId,
        projectId,
        mode: MODE,
        keyspace: '200000000',
        isPermanent: true,
        archivedAt: new Date(),
      })
      .returning({ id: attacks.id })

    const ids = await getArchivedAttackIds(campaignId)
    expect(ids.has(archived!.id)).toBe(true)
    expect(ids.has(activeAttack)).toBe(false)
  })
})
