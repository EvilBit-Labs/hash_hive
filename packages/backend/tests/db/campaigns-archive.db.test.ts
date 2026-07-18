/**
 * Real-DB tests for campaign archiving (ADR-0019): the permanence latch,
 * the hardened delete guard, archive/restore behavior, and the
 * show-archived list filter. These prove SQL-level behavior the mocked
 * default lane cannot — guarded UPDATEs, the latch, and isNull filtering.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). cleanupSeed()
 * in afterAll keeps runs idempotent and order-independent.
 *
 * NOTE: do NOT call client.end() here — harness.test.ts owns the shared
 * drizzle client lifecycle. All db-lane files share the same client.
 */

import { campaigns, hashLists, hashTypes, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'

const TEST_SLUG = 'campaigns-archive-test-proj'
const HASHCAT_MODE = 9_999_823 // unique to this test file

// ─── Seed helpers ───────────────────────────────────────────────────────────

interface SeedCtx {
  projectId: number
  hashListId: number
  hashTypeId: number
}

// Project + hash list are seeded once for the whole file (the project slug is
// unique, so re-seeding per test collides). Each test inserts its own
// campaign(s); afterAll cascades them away via the project FK.
let ctx: SeedCtx

async function seedProjectAndList(): Promise<SeedCtx> {
  const [project] = await db
    .insert(projects)
    .values({ name: TEST_SLUG, slug: TEST_SLUG })
    .returning({ id: projects.id })

  const [hashType] = await db
    .insert(hashTypes)
    .values({ name: 'MD5 (archive test)', hashcatMode: HASHCAT_MODE })
    .returning({ id: hashTypes.id })

  const [hashList] = await db
    .insert(hashLists)
    .values({
      projectId: project!.id,
      name: 'archive-test-list',
      hashTypeId: hashType!.id,
      status: 'ready',
    })
    .returning({ id: hashLists.id })

  return { projectId: project!.id, hashListId: hashList!.id, hashTypeId: hashType!.id }
}

async function insertCampaign(
  overrides: {
    status?: string
    isPermanent?: boolean
    archivedAt?: Date | null
    startedAt?: Date | null
    projectId?: number
    hashListId?: number
    parentCampaignId?: number | null
  } = {}
): Promise<number> {
  const [campaign] = await db
    .insert(campaigns)
    .values({
      name: 'archive-test-campaign',
      projectId: overrides.projectId ?? ctx.projectId,
      hashListId: overrides.hashListId ?? ctx.hashListId,
      priority: 5,
      status: overrides.status ?? 'draft',
      isPermanent: overrides.isPermanent ?? false,
      archivedAt: overrides.archivedAt ?? null,
      startedAt: overrides.startedAt ?? null,
      parentCampaignId: overrides.parentCampaignId ?? null,
    })
    .returning({ id: campaigns.id })
  return campaign!.id
}

async function readCampaign(id: number) {
  const [row] = await db
    .select({
      status: campaigns.status,
      isPermanent: campaigns.isPermanent,
      archivedAt: campaigns.archivedAt,
    })
    .from(campaigns)
    .where(eq(campaigns.id, id))
  return row
}

async function cleanupSeed(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG))
  await db.delete(hashTypes).where(eq(hashTypes.hashcatMode, HASHCAT_MODE))
}

beforeAll(async () => {
  await cleanupSeed()
  ctx = await seedProjectAndList()
})

afterAll(cleanupSeed)

// ─── U3: permanence latch ─────────────────────────────────────────────────────

describe('campaign permanence latch (U3, R1)', () => {
  it('latches is_permanent=true when a campaign leaves draft (draft -> cancelled)', async () => {
    const id = await insertCampaign({ status: 'draft' })

    const { transitionCampaign } = await import('../../src/services/campaigns.js')
    const result = await transitionCampaign(id, 'cancelled')
    expect('error' in result).toBe(false)

    const row = await readCampaign(id)
    expect(row?.status).toBe('cancelled')
    expect(row?.isPermanent).toBe(true)
  })

  it('leaves is_permanent=false for a campaign that was never transitioned out of draft', async () => {
    const id = await insertCampaign({ status: 'draft' })

    const row = await readCampaign(id)
    expect(row?.status).toBe('draft')
    expect(row?.isPermanent).toBe(false)
  })

  it('keeps is_permanent=true when an already-started campaign is edited back to draft', async () => {
    // Editing returns a started campaign to draft (running -> draft) but must
    // NOT clear the latch — otherwise the campaign would become hard-deletable
    // again, losing crack attribution. Regression guard for ADR-0019.
    const id = await insertCampaign({ status: 'running', isPermanent: true, startedAt: new Date() })

    const { transitionCampaign } = await import('../../src/services/campaigns.js')
    const result = await transitionCampaign(id, 'draft')
    expect('error' in result).toBe(false)

    const row = await readCampaign(id)
    expect(row?.status).toBe('draft')
    expect(row?.isPermanent).toBe(true)
  })
})

// ─── U4: delete-guard hardening ───────────────────────────────────────────────

describe('delete guard hardening (U4, R2, R3)', () => {
  it('deletes a pristine draft (not permanent)', async () => {
    const id = await insertCampaign({ status: 'draft', isPermanent: false })
    const { deleteCampaign } = await import('../../src/services/campaign-dashboard.js')
    const res = await deleteCampaign(id, ctx.projectId)
    expect(res.kind).toBe('deleted')
    expect(await readCampaign(id)).toBeUndefined()
  })

  it('rejects deleting a started-then-edited campaign (draft + permanent)', async () => {
    const id = await insertCampaign({ status: 'draft', isPermanent: true, startedAt: new Date() })
    const { deleteCampaign } = await import('../../src/services/campaign-dashboard.js')
    const res = await deleteCampaign(id, ctx.projectId)
    expect(res.kind).toBe('not_deletable')
    expect(await readCampaign(id)).toBeDefined()
  })

  it('rejects deleting a completed campaign', async () => {
    const id = await insertCampaign({ status: 'completed', isPermanent: true })
    const { deleteCampaign } = await import('../../src/services/campaign-dashboard.js')
    const res = await deleteCampaign(id, ctx.projectId)
    expect(res.kind).toBe('not_draft')
    expect(await readCampaign(id)).toBeDefined()
  })
})

// ─── U5: archive / restore ─────────────────────────────────────────────────────

describe('archive / restore (U5, R5, R6, R7, R8)', () => {
  async function archive(ids: number[], projectId = ctx.projectId) {
    const { archiveCampaigns } = await import('../../src/services/campaign-dashboard.js')
    return archiveCampaigns(projectId, ids)
  }
  async function restore(ids: number[], projectId = ctx.projectId) {
    const { restoreCampaigns } = await import('../../src/services/campaign-dashboard.js')
    return restoreCampaigns(projectId, ids)
  }

  it('archives a completed campaign and sets archived_at', async () => {
    const id = await insertCampaign({ status: 'completed', isPermanent: true })
    const [res] = await archive([id])
    expect(res?.outcome).toBe('archived')
    expect((await readCampaign(id))?.archivedAt).not.toBeNull()
  })

  it('archives a cancelled campaign', async () => {
    const id = await insertCampaign({ status: 'cancelled', isPermanent: true })
    const [res] = await archive([id])
    expect(res?.outcome).toBe('archived')
  })

  it('rejects archiving a running campaign (not_archivable)', async () => {
    const id = await insertCampaign({ status: 'running', isPermanent: true })
    const [res] = await archive([id])
    expect(res?.outcome).toBe('not_archivable')
    expect((await readCampaign(id))?.archivedAt).toBeNull()
  })

  it('rejects archiving a paused campaign (not_archivable)', async () => {
    const id = await insertCampaign({ status: 'paused', isPermanent: true })
    const [res] = await archive([id])
    expect(res?.outcome).toBe('not_archivable')
  })

  it('rejects archiving a pristine draft (not_archivable)', async () => {
    const id = await insertCampaign({ status: 'draft', isPermanent: false })
    const [res] = await archive([id])
    expect(res?.outcome).toBe('not_archivable')
  })

  it('reports already_archived when archiving an archived campaign', async () => {
    const id = await insertCampaign({
      status: 'completed',
      isPermanent: true,
      archivedAt: new Date(),
    })
    const [res] = await archive([id])
    expect(res?.outcome).toBe('already_archived')
  })

  it('restores an archived campaign and clears archived_at', async () => {
    const id = await insertCampaign({
      status: 'completed',
      isPermanent: true,
      archivedAt: new Date(),
    })
    const [res] = await restore([id])
    expect(res?.outcome).toBe('restored')
    expect((await readCampaign(id))?.archivedAt).toBeNull()
  })

  it('reports not_archived when restoring a non-archived campaign', async () => {
    const id = await insertCampaign({ status: 'completed', isPermanent: true })
    const [res] = await restore([id])
    expect(res?.outcome).toBe('not_archived')
  })

  it('reports not_found for a cross-project id (scope enforced in the UPDATE)', async () => {
    const id = await insertCampaign({ status: 'completed', isPermanent: true })
    // A different project must not be able to archive this campaign.
    const [res] = await archive([id], ctx.projectId + 100_000)
    expect(res?.outcome).toBe('not_found')
    expect((await readCampaign(id))?.archivedAt).toBeNull()
  })

  it('handles a bulk mixed batch with per-id outcomes', async () => {
    const completed = await insertCampaign({ status: 'completed', isPermanent: true })
    const running = await insertCampaign({ status: 'running', isPermanent: true })
    const missing = ctx.projectId + 200_000
    const results = await archive([completed, running, missing])
    const byId = new Map(results.map((r) => [r.id, r.outcome]))
    expect(byId.get(completed)).toBe('archived')
    expect(byId.get(running)).toBe('not_archivable')
    expect(byId.get(missing)).toBe('not_found')
  })
})

// ─── U6: list show-archived filter ────────────────────────────────────────────

describe('list show-archived filter (U6, R10)', () => {
  const LIST_TEST_SLUG = 'campaigns-archive-list-test'

  it('excludes archived by default and includes them with showArchived', async () => {
    // Isolated project with its OWN hash list so totals are deterministic and
    // project/hash-list/campaign ownership stays consistent. Defensive
    // delete-by-slug first so an interrupted prior run can't collide.
    await db.delete(projects).where(eq(projects.slug, LIST_TEST_SLUG))
    const [proj] = await db
      .insert(projects)
      .values({ name: LIST_TEST_SLUG, slug: LIST_TEST_SLUG })
      .returning({ id: projects.id })
    const projectId = proj!.id
    try {
      const [list] = await db
        .insert(hashLists)
        .values({ projectId, name: 'list-test-list', hashTypeId: ctx.hashTypeId, status: 'ready' })
        .returning({ id: hashLists.id })
      const hashListId = list!.id

      await insertCampaign({ projectId, hashListId, status: 'completed', isPermanent: true })
      await insertCampaign({
        projectId,
        hashListId,
        status: 'completed',
        isPermanent: true,
        archivedAt: new Date(),
      })

      const { listCampaigns } = await import('../../src/services/campaigns.js')

      const def = await listCampaigns({ projectId })
      expect(def.total).toBe(1)
      expect(def.campaigns.every((row) => row.archivedAt === null)).toBe(true)

      const all = await listCampaigns({ projectId, showArchived: true })
      expect(all.total).toBe(2)
    } finally {
      await db.delete(projects).where(eq(projects.id, projectId))
    }
  })
})

// ─── listCampaigns excludes split sub-campaigns (issue #202 second half) ─────

describe('list excludes split sub-campaigns', () => {
  const SPLIT_TEST_SLUG = 'campaigns-archive-split-list-test'

  it('excludes a sub-campaign (parentCampaignId set) from the flat listing, even with showArchived', async () => {
    // Isolated project so totals are deterministic, mirroring the
    // show-archived test above.
    await db.delete(projects).where(eq(projects.slug, SPLIT_TEST_SLUG))
    const [proj] = await db
      .insert(projects)
      .values({ name: SPLIT_TEST_SLUG, slug: SPLIT_TEST_SLUG })
      .returning({ id: projects.id })
    const projectId = proj!.id
    try {
      const [list] = await db
        .insert(hashLists)
        .values({
          projectId,
          name: 'split-list-test-list',
          hashTypeId: ctx.hashTypeId,
          status: 'ready',
        })
        .returning({ id: hashLists.id })
      const hashListId = list!.id

      const parentId = await insertCampaign({ projectId, hashListId })
      await insertCampaign({ projectId, hashListId, parentCampaignId: parentId })

      const { listCampaigns } = await import('../../src/services/campaigns.js')

      const result = await listCampaigns({ projectId })
      expect(result.total).toBe(1)
      expect(result.campaigns.map((c) => c.id)).toEqual([parentId])

      // Sub-campaigns stay excluded even when the caller asks for archived
      // rows too — parentCampaignId filtering is independent of the
      // showArchived toggle.
      const withArchived = await listCampaigns({ projectId, showArchived: true })
      expect(withArchived.total).toBe(1)
      expect(withArchived.campaigns.map((c) => c.id)).toEqual([parentId])
    } finally {
      await db.delete(projects).where(eq(projects.id, projectId))
    }
  })
})
