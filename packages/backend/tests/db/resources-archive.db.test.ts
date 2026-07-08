/**
 * Real-DB tests for hash-list / resource archiving (ADR-0019, issue #106 U3):
 * the permanence latch (fired from every campaigns.ts write site that
 * references a hash list or word/rule/mask list), the hardened
 * draft-only delete guard, archive/restore behavior including the
 * in-use guard, and the show-archived list filter. These prove SQL-level
 * behavior the mocked default lane cannot — guarded UPDATEs, the NOT
 * EXISTS in-use subquery, the latch, and isNull filtering.
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
  hashItems,
  hashLists,
  maskLists,
  projects,
  ruleLists,
  wordLists,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import {
  createAttack,
  createCampaign,
  createCampaignWithAttacks,
  updateAttack,
} from '../../src/services/campaigns.js'
import {
  archiveHashLists,
  archiveResources,
  restoreHashLists,
  restoreResources,
} from '../../src/services/resources-archive.js'
import {
  deleteHashList,
  deleteResource,
  listHashLists,
  listResources,
} from '../../src/services/resources.js'

const TEST_SLUG = 'resources-archive-test-proj'

// ─── Seed helpers ───────────────────────────────────────────────────────────

interface SeedCtx {
  projectId: number
  // A campaign used only to satisfy attacks.campaignId's NOT NULL FK for
  // tests that need an attack row but aren't exercising campaign lifecycle.
  ownerCampaignId: number
}

let ctx: SeedCtx

async function insertHashList(
  overrides: {
    projectId?: number
    // Only 'ready' is exercised by this suite — the archive-consistency
    // check constraint requires it before archivedAt can be set.
    status?: 'ready'
    isPermanent?: boolean
    archivedAt?: Date | null
  } = {}
): Promise<number> {
  const [row] = await db
    .insert(hashLists)
    .values({
      projectId: overrides.projectId ?? ctx.projectId,
      name: 'resources-archive-test-hashlist',
      status: overrides.status ?? 'ready',
      isPermanent: overrides.isPermanent ?? false,
      archivedAt: overrides.archivedAt ?? null,
    })
    .returning({ id: hashLists.id })
  return row!.id
}

async function insertWordList(
  overrides: {
    projectId?: number
    // Only 'ready' is exercised by this suite — the archive-consistency
    // check constraint requires it before archivedAt can be set.
    status?: 'ready'
    isPermanent?: boolean
    archivedAt?: Date | null
  } = {}
): Promise<number> {
  const [row] = await db
    .insert(wordLists)
    .values({
      projectId: overrides.projectId ?? ctx.projectId,
      name: 'resources-archive-test-wordlist',
      status: overrides.status ?? 'ready',
      isPermanent: overrides.isPermanent ?? false,
      archivedAt: overrides.archivedAt ?? null,
    })
    .returning({ id: wordLists.id })
  return row!.id
}

async function insertRuleList(
  overrides: {
    projectId?: number
    // Only 'ready' is exercised by this suite — the archive-consistency
    // check constraint requires it before archivedAt can be set.
    status?: 'ready'
    isPermanent?: boolean
    archivedAt?: Date | null
  } = {}
): Promise<number> {
  const [row] = await db
    .insert(ruleLists)
    .values({
      projectId: overrides.projectId ?? ctx.projectId,
      name: 'resources-archive-test-rulelist',
      status: overrides.status ?? 'ready',
      isPermanent: overrides.isPermanent ?? false,
      archivedAt: overrides.archivedAt ?? null,
    })
    .returning({ id: ruleLists.id })
  return row!.id
}

async function insertMaskList(
  overrides: {
    projectId?: number
    // Only 'ready' is exercised by this suite — the archive-consistency
    // check constraint requires it before archivedAt can be set.
    status?: 'ready'
    isPermanent?: boolean
    archivedAt?: Date | null
  } = {}
): Promise<number> {
  const [row] = await db
    .insert(maskLists)
    .values({
      projectId: overrides.projectId ?? ctx.projectId,
      name: 'resources-archive-test-masklist',
      status: overrides.status ?? 'ready',
      isPermanent: overrides.isPermanent ?? false,
      archivedAt: overrides.archivedAt ?? null,
    })
    .returning({ id: maskLists.id })
  return row!.id
}

async function insertCampaign(
  hashListId: number,
  overrides: {
    projectId?: number
    status?: string
    isPermanent?: boolean
    archivedAt?: Date | null
  } = {}
): Promise<number> {
  const [row] = await db
    .insert(campaigns)
    .values({
      projectId: overrides.projectId ?? ctx.projectId,
      name: 'resources-archive-test-campaign',
      hashListId,
      priority: 5,
      status: overrides.status ?? 'draft',
      isPermanent: overrides.isPermanent ?? false,
      archivedAt: overrides.archivedAt ?? null,
    })
    .returning({ id: campaigns.id })
  return row!.id
}

async function insertAttack(overrides: {
  campaignId?: number
  projectId?: number
  wordlistId?: number | null
  rulelistId?: number | null
  masklistId?: number | null
}): Promise<number> {
  const [row] = await db
    .insert(attacks)
    .values({
      campaignId: overrides.campaignId ?? ctx.ownerCampaignId,
      projectId: overrides.projectId ?? ctx.projectId,
      mode: 0,
      wordlistId: overrides.wordlistId ?? null,
      rulelistId: overrides.rulelistId ?? null,
      masklistId: overrides.masklistId ?? null,
    })
    .returning({ id: attacks.id })
  return row!.id
}

async function readHashList(id: number) {
  const [row] = await db
    .select({
      status: hashLists.status,
      isPermanent: hashLists.isPermanent,
      archivedAt: hashLists.archivedAt,
    })
    .from(hashLists)
    .where(eq(hashLists.id, id))
  return row
}

async function readWordList(id: number) {
  const [row] = await db
    .select({
      status: wordLists.status,
      isPermanent: wordLists.isPermanent,
      archivedAt: wordLists.archivedAt,
    })
    .from(wordLists)
    .where(eq(wordLists.id, id))
  return row
}

async function readRuleList(id: number) {
  const [row] = await db
    .select({
      status: ruleLists.status,
      isPermanent: ruleLists.isPermanent,
      archivedAt: ruleLists.archivedAt,
    })
    .from(ruleLists)
    .where(eq(ruleLists.id, id))
  return row
}

async function readMaskList(id: number) {
  const [row] = await db
    .select({
      status: maskLists.status,
      isPermanent: maskLists.isPermanent,
      archivedAt: maskLists.archivedAt,
    })
    .from(maskLists)
    .where(eq(maskLists.id, id))
  return row
}

async function cleanupSeed(): Promise<void> {
  // Project cascade removes hashLists/wordLists/ruleLists/maskLists/
  // campaigns/attacks/hash_items in one delete.
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG))
}

beforeAll(async () => {
  await cleanupSeed()
  const [project] = await db
    .insert(projects)
    .values({ name: TEST_SLUG, slug: TEST_SLUG })
    .returning({ id: projects.id })
  const projectId = project!.id
  const dummyHashListId = await insertHashList({ projectId })
  const [ownerCampaign] = await db
    .insert(campaigns)
    .values({
      projectId,
      name: 'resources-archive-owner-campaign',
      hashListId: dummyHashListId,
      priority: 5,
      status: 'draft',
      // Single-hash-mode-per-campaign DB backstop (issue #100): must match
      // every attack `insertAttack`/`createAttack` inserts against this
      // campaign in this file (mode 0) — see schema.ts's
      // `attacks_campaign_id_mode_..._fk`.
      hashcatMode: 0,
    })
    .returning({ id: campaigns.id })
  ctx = { projectId, ownerCampaignId: ownerCampaign!.id }
})

afterAll(cleanupSeed)

// ─── Permanence latch (assumption: fires on first reference) ────────────────

describe('permanence latch — hash lists (U3, R1)', () => {
  it('createCampaign latches the referenced hash list is_permanent=true', async () => {
    const hlId = await insertHashList({ isPermanent: false })
    expect((await readHashList(hlId))?.isPermanent).toBe(false)

    const campaign = await createCampaign({
      projectId: ctx.projectId,
      name: 'latch-test',
      hashListId: hlId,
    })
    expect(campaign).not.toBeNull()

    expect((await readHashList(hlId))?.isPermanent).toBe(true)
  })

  it('createCampaignWithAttacks latches the hash list AND each referenced word/rule/mask list', async () => {
    const hlId = await insertHashList({ isPermanent: false })
    const wlId = await insertWordList({ isPermanent: false })

    const result = await createCampaignWithAttacks({
      projectId: ctx.projectId,
      name: 'latch-test-with-attacks',
      hashListId: hlId,
      attacks: [{ mode: 0, wordlistId: wlId }],
    })
    expect(result.kind).toBe('created')

    expect((await readHashList(hlId))?.isPermanent).toBe(true)
    expect((await readWordList(wlId))?.isPermanent).toBe(true)
  })

  it('leaves is_permanent=false for a hash list that was never referenced', async () => {
    const hlId = await insertHashList({ isPermanent: false })
    expect((await readHashList(hlId))?.isPermanent).toBe(false)
  })
})

describe('permanence latch — word/rule/mask lists (U3, R1)', () => {
  it('createAttack latches every non-null wordlist/rulelist/masklist reference', async () => {
    const wlId = await insertWordList({ isPermanent: false })
    const rlId = await insertRuleList({ isPermanent: false })
    const mlId = await insertMaskList({ isPermanent: false })

    const attack = await createAttack({
      campaignId: ctx.ownerCampaignId,
      projectId: ctx.projectId,
      // Single-hash-mode-per-campaign DB backstop (issue #100): must match
      // every other attack `ctx.ownerCampaignId` receives in this file
      // (mode 0, via `insertAttack` below) — this test only cares about
      // the permanence latch, not the mode value itself.
      mode: 0,
      wordlistId: wlId,
      rulelistId: rlId,
      masklistId: mlId,
    })
    expect(attack).not.toBeNull()

    expect((await readWordList(wlId))?.isPermanent).toBe(true)
    expect((await readRuleList(rlId))?.isPermanent).toBe(true)
    expect((await readMaskList(mlId))?.isPermanent).toBe(true)
  })

  it('updateAttack latches a newly-swapped wordlist reference', async () => {
    const wlA = await insertWordList({ isPermanent: false })
    const wlB = await insertWordList({ isPermanent: false })
    const attackId = await insertAttack({ wordlistId: wlA })
    // Direct insert bypasses the service latch — prove the pre-state first.
    expect((await readWordList(wlA))?.isPermanent).toBe(false)

    const updated = await updateAttack(attackId, { wordlistId: wlB })
    expect(updated).not.toBeNull()

    expect((await readWordList(wlB))?.isPermanent).toBe(true)
  })

  it('is idempotent: a second latch call on an already-permanent resource is a no-op', async () => {
    const wlId = await insertWordList({ isPermanent: false })
    const attackA = await insertAttack({ wordlistId: wlId })
    await updateAttack(attackA, { wordlistId: wlId })
    expect((await readWordList(wlId))?.isPermanent).toBe(true)

    // Calling again must not throw or otherwise misbehave.
    await updateAttack(attackA, { wordlistId: wlId })
    expect((await readWordList(wlId))?.isPermanent).toBe(true)
  })
})

// ─── Hash list archive / restore ─────────────────────────────────────────────

describe('hash list archive / restore (U3, R2, R3, R10)', () => {
  it('archives a permanent, unreferenced, ready hash list', async () => {
    const id = await insertHashList({ isPermanent: true, status: 'ready' })
    const [res] = await archiveHashLists(ctx.projectId, [id])
    expect(res?.outcome).toBe('archived')
    expect((await readHashList(id))?.archivedAt).not.toBeNull()
  })

  it('restores an archived hash list', async () => {
    const id = await insertHashList({ isPermanent: true, status: 'ready', archivedAt: new Date() })
    const [res] = await restoreHashLists(ctx.projectId, [id])
    expect(res?.outcome).toBe('restored')
    expect((await readHashList(id))?.archivedAt).toBeNull()
  })

  it('rejects archiving a non-permanent hash list (not_archivable)', async () => {
    const id = await insertHashList({ isPermanent: false, status: 'ready' })
    const [res] = await archiveHashLists(ctx.projectId, [id])
    expect(res?.outcome).toBe('not_archivable')
  })

  it('reports already_archived when archiving an already-archived hash list', async () => {
    const id = await insertHashList({ isPermanent: true, status: 'ready', archivedAt: new Date() })
    const [res] = await archiveHashLists(ctx.projectId, [id])
    expect(res?.outcome).toBe('already_archived')
  })

  it('reports not_archived when restoring a non-archived hash list', async () => {
    const id = await insertHashList({ isPermanent: true, status: 'ready' })
    const [res] = await restoreHashLists(ctx.projectId, [id])
    expect(res?.outcome).toBe('not_archived')
  })

  it('reports not_found for a cross-project id', async () => {
    const id = await insertHashList({ isPermanent: true, status: 'ready' })
    const [res] = await archiveHashLists(ctx.projectId + 100_000, [id])
    expect(res?.outcome).toBe('not_found')
    expect((await readHashList(id))?.archivedAt).toBeNull()
  })

  it('blocks archiving while referenced by a non-archived campaign (in_use)', async () => {
    const id = await insertHashList({ isPermanent: true, status: 'ready' })
    await insertCampaign(id, { status: 'draft' })
    const [res] = await archiveHashLists(ctx.projectId, [id])
    expect(res?.outcome).toBe('in_use')
    expect((await readHashList(id))?.archivedAt).toBeNull()
  })

  it('allows archiving when the only referencing campaign is itself archived', async () => {
    const id = await insertHashList({ isPermanent: true, status: 'ready' })
    await insertCampaign(id, { status: 'completed', isPermanent: true, archivedAt: new Date() })
    const [res] = await archiveHashLists(ctx.projectId, [id])
    expect(res?.outcome).toBe('archived')
  })

  it('retains hash_items and their campaign_id attribution after archiving (R4)', async () => {
    const id = await insertHashList({ isPermanent: true, status: 'ready' })
    // Attribution campaign is deliberately decoupled from the hash list under
    // test (points at the shared dummy hash list) so it never blocks the
    // in-use guard above — hash_items.campaign_id is independent of
    // campaigns.hash_list_id.
    const attributionCampaignId = ctx.ownerCampaignId
    await db.insert(hashItems).values({
      hashListId: id,
      hashValue: 'deadbeefcafef00d',
      campaignId: attributionCampaignId,
      crackedAt: new Date(),
      plaintext: 'hunter2',
    })

    const [res] = await archiveHashLists(ctx.projectId, [id])
    expect(res?.outcome).toBe('archived')

    const [item] = await db.select().from(hashItems).where(eq(hashItems.hashListId, id))
    expect(item?.campaignId).toBe(attributionCampaignId)
    expect(item?.plaintext).toBe('hunter2')
  })

  it('handles a bulk mixed batch with per-id outcomes', async () => {
    const archivable = await insertHashList({ isPermanent: true, status: 'ready' })
    const notArchivable = await insertHashList({ isPermanent: false, status: 'ready' })
    const missing = ctx.projectId + 200_000
    const results = await archiveHashLists(ctx.projectId, [archivable, notArchivable, missing])
    const byId = new Map(results.map((r) => [r.id, r.outcome]))
    expect(byId.get(archivable)).toBe('archived')
    expect(byId.get(notArchivable)).toBe('not_archivable')
    expect(byId.get(missing)).toBe('not_found')
  })
})

describe('hash list show-archived list filter (U3, R10)', () => {
  it('excludes archived by default and includes them with showArchived', async () => {
    const FILTER_SLUG = 'resources-archive-hl-filter-test'
    await db.delete(projects).where(eq(projects.slug, FILTER_SLUG))
    const [proj] = await db
      .insert(projects)
      .values({ name: FILTER_SLUG, slug: FILTER_SLUG })
      .returning({ id: projects.id })
    const projectId = proj!.id
    try {
      await insertHashList({ projectId, isPermanent: true, status: 'ready' })
      await insertHashList({
        projectId,
        isPermanent: true,
        status: 'ready',
        archivedAt: new Date(),
      })

      const def = await listHashLists(projectId)
      expect(def.length).toBe(1)
      expect(def.every((row) => row.archivedAt === null)).toBe(true)

      const all = await listHashLists(projectId, { showArchived: true })
      expect(all.length).toBe(2)
    } finally {
      await db.delete(projects).where(eq(projects.id, projectId))
    }
  })
})

// ─── Word/rule/mask list archive / restore ───────────────────────────────────

describe('word list archive / restore / in-use guard (U3, R2, R3, R10)', () => {
  it('archives a permanent, unreferenced, ready word list', async () => {
    const id = await insertWordList({ isPermanent: true, status: 'ready' })
    const [res] = await archiveResources(wordLists, ctx.projectId, [id])
    expect(res?.outcome).toBe('archived')
    expect((await readWordList(id))?.archivedAt).not.toBeNull()
  })

  it('restores an archived word list', async () => {
    const id = await insertWordList({ isPermanent: true, status: 'ready', archivedAt: new Date() })
    const [res] = await restoreResources(wordLists, ctx.projectId, [id])
    expect(res?.outcome).toBe('restored')
    expect((await readWordList(id))?.archivedAt).toBeNull()
  })

  it('rejects archiving a non-permanent word list (not_archivable)', async () => {
    const id = await insertWordList({ isPermanent: false, status: 'ready' })
    const [res] = await archiveResources(wordLists, ctx.projectId, [id])
    expect(res?.outcome).toBe('not_archivable')
  })

  it('blocks archiving a word list referenced by an attack (in_use)', async () => {
    const id = await insertWordList({ isPermanent: true, status: 'ready' })
    await insertAttack({ wordlistId: id })
    const [res] = await archiveResources(wordLists, ctx.projectId, [id])
    expect(res?.outcome).toBe('in_use')
    expect((await readWordList(id))?.archivedAt).toBeNull()
  })

  it('reports not_found for a cross-project id', async () => {
    const id = await insertWordList({ isPermanent: true, status: 'ready' })
    const [res] = await archiveResources(wordLists, ctx.projectId + 100_000, [id])
    expect(res?.outcome).toBe('not_found')
  })
})

describe('rule/mask list archive attack-FK column mapping (U3, R3)', () => {
  it('archives a rule list and blocks on a referencing attack via rulelistId', async () => {
    const freeId = await insertRuleList({ isPermanent: true, status: 'ready' })
    const [freeRes] = await archiveResources(ruleLists, ctx.projectId, [freeId])
    expect(freeRes?.outcome).toBe('archived')

    const blockedId = await insertRuleList({ isPermanent: true, status: 'ready' })
    await insertAttack({ rulelistId: blockedId })
    const [blockedRes] = await archiveResources(ruleLists, ctx.projectId, [blockedId])
    expect(blockedRes?.outcome).toBe('in_use')
  })

  it('archives a mask list and blocks on a referencing attack via masklistId', async () => {
    const freeId = await insertMaskList({ isPermanent: true, status: 'ready' })
    const [freeRes] = await archiveResources(maskLists, ctx.projectId, [freeId])
    expect(freeRes?.outcome).toBe('archived')

    const blockedId = await insertMaskList({ isPermanent: true, status: 'ready' })
    await insertAttack({ masklistId: blockedId })
    const [blockedRes] = await archiveResources(maskLists, ctx.projectId, [blockedId])
    expect(blockedRes?.outcome).toBe('in_use')
  })
})

describe('resource show-archived list filter (U3, R10)', () => {
  it('excludes archived by default and includes them with showArchived', async () => {
    const FILTER_SLUG = 'resources-archive-wl-filter-test'
    await db.delete(projects).where(eq(projects.slug, FILTER_SLUG))
    const [proj] = await db
      .insert(projects)
      .values({ name: FILTER_SLUG, slug: FILTER_SLUG })
      .returning({ id: projects.id })
    const projectId = proj!.id
    try {
      await insertWordList({ projectId, isPermanent: true, status: 'ready' })
      await insertWordList({
        projectId,
        isPermanent: true,
        status: 'ready',
        archivedAt: new Date(),
      })

      const def = await listResources(wordLists, projectId)
      expect(def.length).toBe(1)
      expect(def.every((row) => row.archivedAt === null)).toBe(true)

      const all = await listResources(wordLists, projectId, { showArchived: true })
      expect(all.length).toBe(2)
    } finally {
      await db.delete(projects).where(eq(projects.id, projectId))
    }
  })
})

// ─── Draft-only hard-delete guard ────────────────────────────────────────────

describe('draft-only hard-delete guard (U3, R2)', () => {
  it('deletes a pristine (never-referenced) hash list', async () => {
    const id = await insertHashList({ isPermanent: false })
    const res = await deleteHashList(id, ctx.projectId)
    expect(res.kind).toBe('deleted')
    expect(await readHashList(id)).toBeUndefined()
  })

  it('rejects deleting a permanent hash list (not_deletable)', async () => {
    const id = await insertHashList({ isPermanent: true, status: 'ready' })
    const res = await deleteHashList(id, ctx.projectId)
    expect(res.kind).toBe('not_deletable')
    expect(await readHashList(id)).toBeDefined()
  })

  it('reports not_found for a missing hash list', async () => {
    const res = await deleteHashList(999_999_999, ctx.projectId)
    expect(res.kind).toBe('not_found')
  })

  it('deletes a pristine (never-referenced) word list', async () => {
    const id = await insertWordList({ isPermanent: false })
    const res = await deleteResource(wordLists, id, ctx.projectId, 'wordlist')
    expect(res.kind).toBe('deleted')
    expect(await readWordList(id)).toBeUndefined()
  })

  it('rejects deleting a permanent word list (not_deletable)', async () => {
    const id = await insertWordList({ isPermanent: true, status: 'ready' })
    const res = await deleteResource(wordLists, id, ctx.projectId, 'wordlist')
    expect(res.kind).toBe('not_deletable')
    expect(await readWordList(id)).toBeDefined()
  })
})
