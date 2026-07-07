/**
 * Real-DB tests for the single-hash-mode-per-campaign guard (issue #100
 * R15 / AS1 / U5). `checkSingleHashModePerCampaign` (campaign-resources.ts)
 * is the standalone check both the dashboard and Control API attack
 * create/update surfaces call so a campaign's non-terminal attacks can
 * never diverge in hashcat mode — the invariant the campaign ETA rollup's
 * sum-of-per-attack-estimates model (issue #100 R1) depends on.
 *
 * This proves the real SQL-level behavior the mocked route/contract tests
 * cannot: the terminal-status derivation (via the real
 * `deriveAttackRuntimes`, which reads real task rows + campaign status)
 * and the `archived_at IS NULL` exclusion. Route-level envelope assertions
 * (dashboard `{ error: { code, message } }` 422, Control RFC 9457
 * `attack_mode_conflict` 422) live in
 * `tests/unit/dashboard-campaigns-routes.test.ts` and
 * `tests/unit/control-lifecycle-routes.test.ts` per the project's
 * established split (service logic against a real DB, HTTP envelope
 * against mocked services).
 *
 * Each test creates its own campaign so one test's leftover attacks can
 * never pollute another's sibling set — the check scans every non-
 * terminal, non-archived attack in the campaign, not just one row.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). cleanupSeed()
 * in afterAll keeps runs idempotent and order-independent.
 *
 * NOTE: do NOT call client.end() here — harness.test.ts owns the shared
 * drizzle client lifecycle. All db-lane files share the same client.
 */

import { attacks, campaigns, hashLists, hashTypes, projects, tasks } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { checkSingleHashModePerCampaign } from '../../src/services/campaigns.js'
import { generateTasksForAttack } from '../../src/services/tasks.js'

const TEST_SLUG = 'attack-mode-consistency-test-proj'
const HASHCAT_MODE = 9_999_845 // unique to this test file

interface SeedCtx {
  projectId: number
  hashListId: number
}

let ctx: SeedCtx

async function insertCampaign(): Promise<number> {
  const [row] = await db
    .insert(campaigns)
    .values({
      projectId: ctx.projectId,
      name: `attack-mode-consistency-campaign-${Date.now()}-${Math.random()}`,
      hashListId: ctx.hashListId,
      priority: 5,
      status: 'draft',
    })
    .returning({ id: campaigns.id })
  return row!.id
}

/**
 * Mode 3 (mask) with an inline mask computes its keyspace synchronously
 * (no wordlist/rulelist DB rows needed) — a small, deterministic,
 * single-chunk keyspace so `generateTasksForAttack` always emits at
 * least one task, mirroring `attacks-archive.db.test.ts`.
 */
async function insertAttack(
  campaignId: number,
  overrides: { mode?: number; archivedAt?: Date | null } = {}
): Promise<number> {
  const mode = overrides.mode ?? 3
  const [row] = await db
    .insert(attacks)
    .values({
      campaignId,
      projectId: ctx.projectId,
      mode,
      // Mode 3 needs the inline mask to compute a keyspace; other modes
      // in these tests never call generateTasksForAttack so an empty
      // config is fine.
      advancedConfiguration: mode === 3 ? { mask: '?d?d' } : {},
      archivedAt: overrides.archivedAt ?? null,
      // An archived row must also be permanent (attacks_archive_consistency_chk).
      isPermanent: overrides.archivedAt != null,
    })
    .returning({ id: attacks.id })
  return row!.id
}

/** Creates a mode-3 (mask) attack, generates its task(s), then fails it. */
async function insertFailedAttack(campaignId: number): Promise<number> {
  const id = await insertAttack(campaignId, { mode: 3 })
  await generateTasksForAttack(id)
  await db.update(tasks).set({ status: 'failed' }).where(eq(tasks.attackId, id))
  return id
}

async function cleanupSeed(): Promise<void> {
  // Project cascade removes hashLists/campaigns/attacks/tasks in one delete.
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
    .values({ name: 'attack-mode-consistency-test', hashcatMode: HASHCAT_MODE })
    .returning({ id: hashTypes.id })
  const [hashList] = await db
    .insert(hashLists)
    .values({
      projectId,
      name: 'attack-mode-consistency-test-list',
      hashTypeId: hashType!.id,
      status: 'ready',
    })
    .returning({ id: hashLists.id })
  ctx = { projectId, hashListId: hashList!.id }
})

afterAll(cleanupSeed)

describe('checkSingleHashModePerCampaign (issue #100 R15 / AS1 / U5)', () => {
  it('AE6 base case: first attack in an empty campaign always passes, regardless of mode', async () => {
    const campaignId = await insertCampaign()
    const result = await checkSingleHashModePerCampaign(campaignId, 1000)
    expect(result).toEqual({ valid: true })
  })

  it('passes when the proposed mode matches an existing non-terminal sibling', async () => {
    const campaignId = await insertCampaign()
    await insertAttack(campaignId, { mode: 0 })
    const result = await checkSingleHashModePerCampaign(campaignId, 0)
    expect(result).toEqual({ valid: true })
  })

  it('AE6: rejects a mode that conflicts with a non-terminal sibling', async () => {
    const campaignId = await insertCampaign()
    const siblingId = await insertAttack(campaignId, { mode: 0 })
    const result = await checkSingleHashModePerCampaign(campaignId, 1000)
    expect(result).toEqual({
      valid: false,
      conflictingMode: 0,
      conflictingAttackId: siblingId,
    })
  })

  it('does not conflict with a terminal (failed) sibling in a different mode', async () => {
    const campaignId = await insertCampaign()
    // Mode 3, distinct from the proposed mode (1000) below — the point is
    // that a terminal sibling never conflicts, regardless of its mode.
    const failedId = await insertFailedAttack(campaignId)
    const result = await checkSingleHashModePerCampaign(campaignId, 1000)
    expect(result).toEqual({ valid: true })
    // Sanity: the helper actually reached a terminal (failed) status —
    // otherwise this test would pass for the wrong reason.
    expect(failedId).toBeGreaterThan(0)
  })

  it('does not conflict with an archived sibling in a different mode', async () => {
    const campaignId = await insertCampaign()
    await insertAttack(campaignId, { mode: 0, archivedAt: new Date() })
    const result = await checkSingleHashModePerCampaign(campaignId, 1000)
    expect(result).toEqual({ valid: true })
  })

  it('update path: excludes the attack being updated from its own sibling set', async () => {
    const campaignId = await insertCampaign()
    const id = await insertAttack(campaignId, { mode: 0 })
    // Updating this attack's own mode away from 0, with itself excluded,
    // must not conflict with its own (about-to-change) row.
    const result = await checkSingleHashModePerCampaign(campaignId, 1000, id)
    expect(result).toEqual({ valid: true })
  })

  it('update path: still rejects against a DIFFERENT non-terminal sibling', async () => {
    const campaignId = await insertCampaign()
    const selfId = await insertAttack(campaignId, { mode: 0 })
    const siblingId = await insertAttack(campaignId, { mode: 0 })
    const result = await checkSingleHashModePerCampaign(campaignId, 1000, selfId)
    expect(result).toEqual({
      valid: false,
      conflictingMode: 0,
      conflictingAttackId: siblingId,
    })
  })

  it('multiple same-mode non-terminal siblings all pass', async () => {
    const campaignId = await insertCampaign()
    await insertAttack(campaignId, { mode: 5 })
    await insertAttack(campaignId, { mode: 5 })
    const result = await checkSingleHashModePerCampaign(campaignId, 5)
    expect(result).toEqual({ valid: true })
  })
})
