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
import { and, eq, isNull } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import {
  checkSingleHashModePerCampaign,
  createAttack,
  createCampaignWithAttacks,
  isModeConsistencyFkViolation,
  updateAttack,
} from '../../src/services/campaigns.js'
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
  // Single-hash-mode-per-campaign DB backstop (issue #100): this raw
  // fixture insert bypasses `createAttack`'s coordinating latch, so mirror
  // it here — every test in this file inserts a single consistent mode per
  // campaign (the "conflicting" mode arguments passed to
  // `checkSingleHashModePerCampaign` below are never actually persisted as
  // a second attack row).
  await db
    .update(campaigns)
    .set({ hashcatMode: mode })
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.hashcatMode)))
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

// ─── createCampaignWithAttacks: single-mode enforcement on the one-shot
// create path (issue #100 R15 / AS1 code review fix) ────────────────────
//
// `checkSingleHashModePerCampaign` above guards the standalone attack-write
// routes, which compare a proposed mode against EXISTING db rows. The
// transactional campaign+attacks create has no existing rows to compare
// against — its own attacks[] input is the only source of a conflict — so
// this is a separate code path with its own real-DB coverage.

describe('createCampaignWithAttacks: single-hash-mode-per-campaign guard (issue #100 R15 / AS1)', () => {
  it('rejects a one-shot create whose inline attacks mix hashcat modes', async () => {
    const result = await createCampaignWithAttacks({
      projectId: ctx.projectId,
      name: `mode-conflict-create-${Date.now()}-${Math.random()}`,
      hashListId: ctx.hashListId,
      attacks: [{ mode: 0 }, { mode: 1000 }],
    })
    expect(result).toEqual({ kind: 'mode_conflict', modes: [0, 1000] })
  })

  it('accepts a one-shot create whose inline attacks all share one mode', async () => {
    const result = await createCampaignWithAttacks({
      projectId: ctx.projectId,
      name: `mode-consistent-create-${Date.now()}-${Math.random()}`,
      hashListId: ctx.hashListId,
      attacks: [{ mode: 0 }, { mode: 0 }],
    })
    expect(result.kind).toBe('created')
    if (result.kind === 'created') {
      expect(result.attacks).toHaveLength(2)
    }
  })

  it('sets campaigns.hashcatMode from the shared inline mode', async () => {
    const result = await createCampaignWithAttacks({
      projectId: ctx.projectId,
      name: `mode-latch-create-${Date.now()}-${Math.random()}`,
      hashListId: ctx.hashListId,
      attacks: [{ mode: 42 }, { mode: 42 }],
    })
    expect(result.kind).toBe('created')
    if (result.kind !== 'created') return
    const [campaign] = await db
      .select({ hashcatMode: campaigns.hashcatMode })
      .from(campaigns)
      .where(eq(campaigns.id, result.campaign.id))
      .limit(1)
    expect(campaign?.hashcatMode).toBe(42)
  })

  it('leaves campaigns.hashcatMode NULL when created with no inline attacks', async () => {
    const result = await createCampaignWithAttacks({
      projectId: ctx.projectId,
      name: `mode-latch-empty-${Date.now()}-${Math.random()}`,
      hashListId: ctx.hashListId,
      attacks: [],
    })
    expect(result.kind).toBe('created')
    if (result.kind !== 'created') return
    const [campaign] = await db
      .select({ hashcatMode: campaigns.hashcatMode })
      .from(campaigns)
      .where(eq(campaigns.id, result.campaign.id))
      .limit(1)
    expect(campaign?.hashcatMode).toBeNull()
  })
})

// ─── DB-level TOCTOU backstop (issue #100): the composite FK closes the
// race `checkSingleHashModePerCampaign`'s read-then-write pre-check cannot
// close on its own. These tests call `createAttack` directly — bypassing
// the route-level pre-check entirely, the same way two concurrent requests
// that both read a stale "no conflicting sibling" snapshot would — to prove
// the FK, not the app-level check, is what actually makes a mixed-mode
// campaign impossible to land.

describe('single-hash-mode-per-campaign DB backstop: composite FK (issue #100)', () => {
  it('createAttack latches campaigns.hashcatMode from the first attack', async () => {
    const campaignId = await insertCampaign()
    const attack = await createAttack({ campaignId, projectId: ctx.projectId, mode: 7 })
    expect(attack).not.toBeNull()

    const [campaign] = await db
      .select({ hashcatMode: campaigns.hashcatMode })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1)
    expect(campaign?.hashcatMode).toBe(7)
  })

  it('a second createAttack with a matching mode succeeds (the FK is satisfied, not just avoided)', async () => {
    const campaignId = await insertCampaign()
    await createAttack({ campaignId, projectId: ctx.projectId, mode: 7 })
    const second = await createAttack({ campaignId, projectId: ctx.projectId, mode: 7 })
    expect(second).not.toBeNull()
  })

  it('a second createAttack with a DIFFERENT mode is rejected by the FK, with the app-level pre-check bypassed', async () => {
    const campaignId = await insertCampaign()
    await createAttack({ campaignId, projectId: ctx.projectId, mode: 7 })

    // `createAttack` never calls `checkSingleHashModePerCampaign` itself
    // (that pre-check runs in the route handlers, before the service is
    // invoked) — calling the service directly here proves the FK alone,
    // with no app-level gate in front of it, still blocks a mixed mode.
    let caught: unknown
    try {
      await createAttack({ campaignId, projectId: ctx.projectId, mode: 1000 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(isModeConsistencyFkViolation(caught)).toBe(true)

    // The rejected insert must not have landed, and the campaign's latched
    // mode must be unchanged.
    const siblings = await db.select().from(attacks).where(eq(attacks.campaignId, campaignId))
    expect(siblings).toHaveLength(1)
    expect(siblings[0]?.mode).toBe(7)
  })

  it('two concurrent createAttack calls of different modes: exactly one wins, the loser is FK-rejected', async () => {
    const campaignId = await insertCampaign()

    const results = await Promise.allSettled([
      createAttack({ campaignId, projectId: ctx.projectId, mode: 111 }),
      createAttack({ campaignId, projectId: ctx.projectId, mode: 222 }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const rejection = rejected[0]
    if (rejection && rejection.status === 'rejected') {
      expect(isModeConsistencyFkViolation(rejection.reason)).toBe(true)
    }

    // Only the winner's attack landed, and it set the campaign's mode.
    const siblings = await db.select().from(attacks).where(eq(attacks.campaignId, campaignId))
    expect(siblings).toHaveLength(1)
    const [campaign] = await db
      .select({ hashcatMode: campaigns.hashcatMode })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1)
    expect(campaign?.hashcatMode).toBe(siblings[0]?.mode)
  })
})

// ─── updateAttack: adaptive latch on mode edits (issue #100 product
// follow-up) ────────────────────────────────────────────────────────
//
// `createAttack`'s latch is set-once (first attack ever wins forever),
// which would make a SOLE attack's mode permanently frozen — stricter
// than the invariant it exists to enforce (every attack in a campaign
// shares one mode). `updateAttack` instead adopts the new mode onto the
// campaign whenever no OTHER attack in the campaign disagrees, so editing
// the only attack's mode (or bringing every attack into agreement) always
// succeeds, while a real conflict still hits the FK.

describe('updateAttack: adaptive campaign-mode latch (issue #100)', () => {
  it('editing the sole attack in a campaign succeeds and campaigns.hashcatMode follows the new mode', async () => {
    const campaignId = await insertCampaign()
    const attackId = await createAttack({ campaignId, projectId: ctx.projectId, mode: 7 }).then(
      (a) => a!.id
    )

    const updated = await updateAttack(attackId, { mode: 1000 })
    expect(updated?.mode).toBe(1000)

    const [campaign] = await db
      .select({ hashcatMode: campaigns.hashcatMode })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1)
    expect(campaign?.hashcatMode).toBe(1000)
  })

  it('editing one attack of a multi-attack same-mode campaign to a different mode is FK-rejected', async () => {
    const campaignId = await insertCampaign()
    const attackA = await createAttack({ campaignId, projectId: ctx.projectId, mode: 7 }).then(
      (a) => a!.id
    )
    await createAttack({ campaignId, projectId: ctx.projectId, mode: 7 })

    let caught: unknown
    try {
      await updateAttack(attackA, { mode: 1000 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(isModeConsistencyFkViolation(caught)).toBe(true)

    // Neither the attack's mode nor the campaign's latched mode moved.
    const [attackRow] = await db
      .select({ mode: attacks.mode })
      .from(attacks)
      .where(eq(attacks.id, attackA))
      .limit(1)
    expect(attackRow?.mode).toBe(7)
    const [campaign] = await db
      .select({ hashcatMode: campaigns.hashcatMode })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1)
    expect(campaign?.hashcatMode).toBe(7)
  })

  it('a no-op edit that keeps the mode every attack already shares succeeds (NOT EXISTS tolerates full agreement)', async () => {
    const campaignId = await insertCampaign()
    const attackA = await createAttack({ campaignId, projectId: ctx.projectId, mode: 7 }).then(
      (a) => a!.id
    )
    await createAttack({ campaignId, projectId: ctx.projectId, mode: 7 })

    const updated = await updateAttack(attackA, { mode: 7 })
    expect(updated?.mode).toBe(7)

    const [campaign] = await db
      .select({ hashcatMode: campaigns.hashcatMode })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1)
    expect(campaign?.hashcatMode).toBe(7)
  })
})
