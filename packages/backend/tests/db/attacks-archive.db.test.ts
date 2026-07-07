/**
 * Real-DB tests for attack archiving (ADR-0019, issue #106 U6): the
 * permanence latch (fires on first task generation, not on create like
 * campaigns/resources), the hardened draft/task-less-only delete guard,
 * archive/restore behavior (no `in_use` guard — nothing references an
 * attack the way campaigns reference hash lists), and the scheduler /
 * campaign-editor exclusion of archived attacks. These prove SQL-level
 * behavior the mocked default lane cannot — guarded UPDATEs, the latch
 * firing inside the task-insert transaction, and isNull filtering.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). cleanupSeed()
 * in afterAll keeps runs idempotent and order-independent.
 *
 * NOTE: do NOT call client.end() here — harness.test.ts owns the shared
 * drizzle client lifecycle. All db-lane files share the same client.
 */

import {
  attacks,
  campaigns,
  hashLists,
  hashTypes,
  projects,
  tasks,
  wordLists,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { archiveAttacks, restoreAttacks } from '../../src/services/campaigns-attacks-archive.js'
import { deleteAttack, latchAttackPermanent, listAttacks } from '../../src/services/campaigns.js'
import { generateTasksForAttack } from '../../src/services/tasks.js'

const TEST_SLUG = 'attacks-archive-test-proj'
const HASHCAT_MODE = 9_999_844 // unique to this test file

interface SeedCtx {
  projectId: number
  campaignId: number
  hashListId: number
}

let ctx: SeedCtx

/**
 * A fresh campaign for tests that must not observe (or be observed by)
 * `ctx.campaignId`'s accumulated attacks from other tests in this file —
 * needed once a test starts asserting on the single-hash-mode-per-campaign
 * sibling scan (issue #100 R15 / AS1), which would otherwise see every
 * mode-3 attack every earlier test in this file ever left non-archived in
 * the shared campaign. Mirrors attack-mode-consistency.db.test.ts's
 * per-test `insertCampaign`.
 */
async function insertCampaign(): Promise<number> {
  const [row] = await db
    .insert(campaigns)
    .values({
      projectId: ctx.projectId,
      name: `attacks-archive-test-campaign-${Date.now()}-${Math.random()}`,
      hashListId: ctx.hashListId,
      priority: 5,
      status: 'draft',
    })
    .returning({ id: campaigns.id })
  return row!.id
}

async function insertAttack(overrides: { campaignId?: number; projectId?: number } = {}) {
  const [row] = await db
    .insert(attacks)
    .values({
      campaignId: overrides.campaignId ?? ctx.campaignId,
      projectId: overrides.projectId ?? ctx.projectId,
      // Mode 3 (mask) with an inline mask computes its keyspace synchronously
      // (no wordlist/rulelist DB rows needed) — a small, deterministic,
      // single-chunk keyspace so generateTasksForAttack always emits at
      // least one task.
      mode: 3,
      advancedConfiguration: { mask: '?d?d' },
    })
    .returning({ id: attacks.id })
  return row!.id
}

async function readAttack(id: number) {
  const [row] = await db
    .select({ isPermanent: attacks.isPermanent, archivedAt: attacks.archivedAt })
    .from(attacks)
    .where(eq(attacks.id, id))
  return row
}

async function taskCountForAttack(id: number): Promise<number> {
  const rows = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.attackId, id))
  return rows.length
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
    .values({ name: 'attacks-archive-test', hashcatMode: HASHCAT_MODE })
    .returning({ id: hashTypes.id })
  const [hashList] = await db
    .insert(hashLists)
    .values({
      projectId,
      name: 'attacks-archive-test-list',
      hashTypeId: hashType!.id,
      status: 'ready',
    })
    .returning({ id: hashLists.id })
  const [campaign] = await db
    .insert(campaigns)
    .values({
      projectId,
      name: 'attacks-archive-test-campaign',
      hashListId: hashList!.id,
      priority: 5,
      status: 'draft',
    })
    .returning({ id: campaigns.id })
  ctx = { projectId, campaignId: campaign!.id, hashListId: hashList!.id }
})

afterAll(cleanupSeed)

// ─── Permanence latch on first task generation ───────────────────────

describe('attack permanence latch (U6, assumption: fires on first task generation)', () => {
  it('leaves is_permanent=false for an attack with no tasks generated', async () => {
    const id = await insertAttack()
    expect((await readAttack(id))?.isPermanent).toBe(false)
    expect(await taskCountForAttack(id)).toBe(0)
  })

  it('latches is_permanent=true when the first task is generated', async () => {
    const id = await insertAttack()
    expect((await readAttack(id))?.isPermanent).toBe(false)

    const result = await generateTasksForAttack(id)
    expect(result.count).toBeGreaterThan(0)

    expect((await readAttack(id))?.isPermanent).toBe(true)
  })

  it('is idempotent: generating tasks a second time does not error and stays latched', async () => {
    const id = await insertAttack()
    await generateTasksForAttack(id)
    expect((await readAttack(id))?.isPermanent).toBe(true)

    // Re-generation (e.g. a retry) must not throw and must leave the latch set.
    await generateTasksForAttack(id)
    expect((await readAttack(id))?.isPermanent).toBe(true)
  })

  it('directly exercises latchAttackPermanent as a no-op on an already-permanent attack', async () => {
    const id = await insertAttack()
    await generateTasksForAttack(id)
    expect((await readAttack(id))?.isPermanent).toBe(true)

    await db.transaction(async (tx) => {
      await latchAttackPermanent(tx, id)
    })
    expect((await readAttack(id))?.isPermanent).toBe(true)
  })
})

// ─── Draft/task-less-only hard-delete guard ──────────────────────────

describe('attack delete guard (U6, R2)', () => {
  it('hard-deletes a task-less (never-run) attack', async () => {
    const id = await insertAttack()
    const res = await deleteAttack(id)
    expect(res.kind).toBe('deleted')
    expect(await readAttack(id)).toBeUndefined()
  })

  it('rejects deleting a permanent (has-run) attack', async () => {
    const id = await insertAttack()
    await generateTasksForAttack(id)
    const res = await deleteAttack(id)
    expect(res.kind).toBe('not_deletable')
    expect(await readAttack(id)).toBeDefined()
  })

  it('reports not_found for a missing attack', async () => {
    const res = await deleteAttack(999_999_999)
    expect(res.kind).toBe('not_found')
  })
})

// ─── Archive / restore ────────────────────────────────────────────────

describe('attack archive / restore (U6, R5, R6, R10)', () => {
  it('archives a permanent (has-run) attack', async () => {
    const id = await insertAttack()
    await generateTasksForAttack(id)
    const [res] = await archiveAttacks(ctx.projectId, [id])
    expect(res?.outcome).toBe('archived')
    expect((await readAttack(id))?.archivedAt).not.toBeNull()
  })

  it('rejects archiving a task-less attack (not_archivable)', async () => {
    const id = await insertAttack()
    const [res] = await archiveAttacks(ctx.projectId, [id])
    expect(res?.outcome).toBe('not_archivable')
    expect((await readAttack(id))?.archivedAt).toBeNull()
  })

  it('reports already_archived when archiving an already-archived attack', async () => {
    const id = await insertAttack()
    await generateTasksForAttack(id)
    await archiveAttacks(ctx.projectId, [id])
    const [res] = await archiveAttacks(ctx.projectId, [id])
    expect(res?.outcome).toBe('already_archived')
  })

  it('reports not_found for a cross-project id', async () => {
    const id = await insertAttack()
    await generateTasksForAttack(id)
    const [res] = await archiveAttacks(ctx.projectId + 100_000, [id])
    expect(res?.outcome).toBe('not_found')
    expect((await readAttack(id))?.archivedAt).toBeNull()
  })

  it('restores an archived attack and clears archived_at', async () => {
    const id = await insertAttack()
    await generateTasksForAttack(id)
    await archiveAttacks(ctx.projectId, [id])
    const [res] = await restoreAttacks(ctx.projectId, [id])
    expect(res?.outcome).toBe('restored')
    expect((await readAttack(id))?.archivedAt).toBeNull()
  })

  it('reports not_archived when restoring a non-archived attack', async () => {
    const id = await insertAttack()
    await generateTasksForAttack(id)
    const [res] = await restoreAttacks(ctx.projectId, [id])
    expect(res?.outcome).toBe('not_archived')
  })

  it('handles a bulk mixed batch with per-id outcomes', async () => {
    const archivable = await insertAttack()
    await generateTasksForAttack(archivable)
    const notArchivable = await insertAttack()
    const missing = ctx.projectId + 200_000
    const results = await archiveAttacks(ctx.projectId, [archivable, notArchivable, missing])
    const byId = new Map(results.map((r) => [r.id, r.outcome]))
    expect(byId.get(archivable)).toBe('archived')
    expect(byId.get(notArchivable)).toBe('not_archivable')
    expect(byId.get(missing)).toBe('not_found')
  })

  it('retains task rows attributed to the attack after archiving', async () => {
    const id = await insertAttack()
    await generateTasksForAttack(id)
    const before = await taskCountForAttack(id)
    expect(before).toBeGreaterThan(0)

    const [res] = await archiveAttacks(ctx.projectId, [id])
    expect(res?.outcome).toBe('archived')

    const after = await taskCountForAttack(id)
    expect(after).toBe(before)
  })
})

// ─── Scheduler / campaign-editor exclusion ───────────────────────────

describe('archived attack excluded from listAttacks (U6, R6, R10)', () => {
  it('excludes an archived attack by default and includes it with showArchived', async () => {
    const active = await insertAttack()
    await generateTasksForAttack(active)

    const archived = await insertAttack()
    await generateTasksForAttack(archived)
    await archiveAttacks(ctx.projectId, [archived])

    const defaultList = await listAttacks(ctx.campaignId)
    const defaultIds = defaultList.map((a) => a.id)
    expect(defaultIds).toContain(active)
    expect(defaultIds).not.toContain(archived)

    const fullList = await listAttacks(ctx.campaignId, { showArchived: true })
    const fullIds = fullList.map((a) => a.id)
    expect(fullIds).toContain(active)
    expect(fullIds).toContain(archived)
  })

  it('re-includes a restored attack in the default listing', async () => {
    const id = await insertAttack()
    await generateTasksForAttack(id)
    await archiveAttacks(ctx.projectId, [id])
    expect((await listAttacks(ctx.campaignId)).map((a) => a.id)).not.toContain(id)

    await restoreAttacks(ctx.projectId, [id])
    expect((await listAttacks(ctx.campaignId)).map((a) => a.id)).toContain(id)
  })
})

// ─── Reclaimed-shell restore guard (F2, issue #106 code review) ─────

async function insertReclaimedWordList(): Promise<number> {
  const [row] = await db
    .insert(wordLists)
    .values({
      projectId: ctx.projectId,
      name: 'attack-restore-reclaimed-wordlist',
      status: 'ready',
      isPermanent: true,
      archivedAt: new Date('2025-01-01T00:00:00Z'),
      blobReclaimedAt: new Date('2025-06-01T00:00:00Z'),
      fileChecksum: 'deadbeefcafef00d',
      fileRef: {},
    })
    .returning({ id: wordLists.id })
  return row!.id
}

/**
 * `campaignId` defaults to a FRESH campaign (not the shared `ctx.campaignId`)
 * — restoring now also runs the single-hash-mode-per-campaign guard (issue
 * #100 R15 / AS1), which would otherwise see every mode-3 attack every
 * other test in this file has ever left non-archived in the shared
 * campaign and spuriously reject the restore.
 */
async function insertArchivedAttackReferencing(
  wordlistId: number,
  campaignId?: number
): Promise<number> {
  const [row] = await db
    .insert(attacks)
    .values({
      campaignId: campaignId ?? (await insertCampaign()),
      projectId: ctx.projectId,
      mode: 0,
      wordlistId,
      isPermanent: true,
      archivedAt: new Date(),
    })
    .returning({ id: attacks.id })
  return row!.id
}

describe('restoreAttacks: reclaimed-shell guard (F2, issue #106 code review)', () => {
  it('refuses to restore an attack referencing a reclaimed-shell wordlist, and leaves it archived', async () => {
    const wordlistId = await insertReclaimedWordList()
    const id = await insertArchivedAttackReferencing(wordlistId)

    const [res] = await restoreAttacks(ctx.projectId, [id])
    expect(res?.outcome).toBe('resource_reclaimed')

    const after = await readAttack(id)
    expect(after?.archivedAt).not.toBeNull()
  })

  it('restores normally once the referenced resource is no longer a reclaimed shell (re-uploaded)', async () => {
    const wordlistId = await insertReclaimedWordList()
    const id = await insertArchivedAttackReferencing(wordlistId)

    // Simulate a successful checksum-verified re-upload (proven elsewhere):
    // blob_reclaimed_at clears, the resource is usable again.
    await db.update(wordLists).set({ blobReclaimedAt: null }).where(eq(wordLists.id, wordlistId))

    const [res] = await restoreAttacks(ctx.projectId, [id])
    expect(res?.outcome).toBe('restored')
    expect((await readAttack(id))?.archivedAt).toBeNull()
  })

  it('does not block restoring an attack referencing an unrelated, usable wordlist', async () => {
    const [usable] = await db
      .insert(wordLists)
      .values({
        projectId: ctx.projectId,
        name: 'attack-restore-usable-wordlist',
        status: 'ready',
        isPermanent: true,
        fileRef: {},
      })
      .returning({ id: wordLists.id })
    const id = await insertArchivedAttackReferencing(usable!.id)

    const [res] = await restoreAttacks(ctx.projectId, [id])
    expect(res?.outcome).toBe('restored')
  })
})

// ─── restoreAttacks: single-hash-mode-per-campaign guard (issue #100
// R15 / AS1 code review fix) ──────────────────────────────────────────
//
// Each test here uses its OWN fresh campaign (via `insertCampaign`), not
// the shared `ctx.campaignId` — restoring now also runs the single-hash-
// mode-per-campaign sibling scan, which would otherwise see every mode-3
// attack every earlier test in this file left non-archived in the shared
// campaign and spuriously reject (or pass) the restore for the wrong
// reason.

async function insertAttackWithMode(campaignId: number, mode: number): Promise<number> {
  const [row] = await db
    .insert(attacks)
    .values({ campaignId, projectId: ctx.projectId, mode })
    .returning({ id: attacks.id })
  return row!.id
}

describe('restoreAttacks: single-hash-mode-per-campaign guard (issue #100 R15 / AS1)', () => {
  it('refuses to restore an attack that would reintroduce a mode conflict, and leaves it archived', async () => {
    const campaignId = await insertCampaign()

    // A (mode 3) generates a task so it is archivable, then gets
    // archived — at that point it has no non-archived siblings, so
    // archiving itself never needed the mode-consistency guard.
    const attackA = await insertAttack({ campaignId })
    await generateTasksForAttack(attackA)
    const [archiveRes] = await archiveAttacks(ctx.projectId, [attackA])
    expect(archiveRes?.outcome).toBe('archived')

    // B (mode 0) is created while A is archived, so B's own create-time
    // mode check saw no non-archived mode-3 sibling to conflict with.
    await insertAttackWithMode(campaignId, 0)

    // Restoring A now would make it a non-archived mode-3 sibling of B
    // (mode 0) — the exact mixed-mode campaign the guard exists to
    // prevent.
    const [restoreRes] = await restoreAttacks(ctx.projectId, [attackA])
    expect(restoreRes?.outcome).toBe('mode_conflict')
    expect((await readAttack(attackA))?.archivedAt).not.toBeNull()
  })

  it('restores normally once the conflicting sibling is also archived', async () => {
    const campaignId = await insertCampaign()

    const attackA = await insertAttack({ campaignId })
    await generateTasksForAttack(attackA)
    await archiveAttacks(ctx.projectId, [attackA])

    const attackB = await insertAttackWithMode(campaignId, 0)
    await db
      .update(attacks)
      .set({ archivedAt: new Date(), isPermanent: true })
      .where(eq(attacks.id, attackB))

    const [restoreRes] = await restoreAttacks(ctx.projectId, [attackA])
    expect(restoreRes?.outcome).toBe('restored')
    expect((await readAttack(attackA))?.archivedAt).toBeNull()
  })
})
