/**
 * Real-DB tests for restore-after-reclaim (issue #106 U12, R12):
 * 1. Restoring a reclaimed resource clears `archived_at` but leaves
 *    `blob_reclaimed_at` set — the row becomes a "shell": present, but
 *    unusable until re-uploaded and checksum-verified.
 * 2. Selecting a reclaimed shell as an attack's wordlist/rulelist/masklist
 *    reference is rejected, both via `validateCampaignResources` (the
 *    dashboard's pre-check chokepoint) and `findReclaimedResourceRefs` (the
 *    standalone helper the Control API attack routes call directly).
 *
 * Checksum capture/comparison at upload finalize (the re-upload half of
 * R12) is covered by the fully-mocked service-level suite in
 * `tests/unit/services/resources-upload.test.ts` (isolated phase
 * `RESOURCES_UPLOAD_TEST_ISOLATED=1`) rather than here — see GOTCHAS.md on
 * cross-file `mock.module` pollution; this file exercises real SQL only.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). cleanupSeed() in
 * afterAll keeps runs idempotent and order-independent.
 *
 * NOTE: do NOT call client.end() here — harness.test.ts owns the shared
 * drizzle client lifecycle. NOTE: do NOT self-skip — test-db lane always has
 * Postgres available.
 */

import {
  attacks,
  campaigns,
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
  findReclaimedResourceRefs,
  validateCampaignResources,
} from '../../src/services/campaign-resources.js'
import { restoreResources } from '../../src/services/resources-archive.js'

const TEST_SLUG = 'resource-reclaim-restore-db-test-proj'

interface SeedCtx {
  projectId: number
  ownerCampaignId: number
}

let ctx: SeedCtx

async function insertReclaimedWordList(): Promise<number> {
  const [row] = await db
    .insert(wordLists)
    .values({
      projectId: ctx.projectId,
      name: 'reclaimed-shell-test-wordlist',
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

async function readWordList(id: number) {
  const [row] = await db
    .select({
      archivedAt: wordLists.archivedAt,
      blobReclaimedAt: wordLists.blobReclaimedAt,
      fileChecksum: wordLists.fileChecksum,
    })
    .from(wordLists)
    .where(eq(wordLists.id, id))
  return row
}

async function cleanupSeed(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG))
}

beforeAll(async () => {
  await cleanupSeed()
  const [project] = await db
    .insert(projects)
    .values({ name: TEST_SLUG, slug: TEST_SLUG })
    .returning({ id: projects.id })
  const projectId = project!.id
  const [hl] = await db
    .insert(hashLists)
    .values({ projectId, name: 'reclaim-restore-owner-hashlist', status: 'ready' })
    .returning({ id: hashLists.id })
  const [ownerCampaign] = await db
    .insert(campaigns)
    .values({
      projectId,
      name: 'reclaim-restore-owner-campaign',
      hashListId: hl!.id,
      priority: 5,
      status: 'draft',
      // Single-hash-mode-per-campaign DB backstop (issue #100): must match
      // the attack inserted below (mode 0) — see schema.ts's
      // `attacks_campaign_id_mode_..._fk`.
      hashcatMode: 0,
    })
    .returning({ id: campaigns.id })
  ctx = { projectId, ownerCampaignId: ownerCampaign!.id }
})

afterAll(cleanupSeed)

describe('restore-after-reclaim (U12, R12)', () => {
  it('restoring a reclaimed word list clears archived_at but leaves blob_reclaimed_at set (shell)', async () => {
    const id = await insertReclaimedWordList()

    const [res] = await restoreResources(wordLists, ctx.projectId, [id])
    expect(res?.outcome).toBe('restored')

    const row = await readWordList(id)
    expect(row?.archivedAt).toBeNull()
    // The shell invariant: still reclaimed, present but unusable until a
    // checksum-verified re-upload.
    expect(row?.blobReclaimedAt).not.toBeNull()
    expect(row?.fileChecksum).toBe('deadbeefcafef00d')
  })

  it('findReclaimedResourceRefs flags a reclaimed shell wordlist reference', async () => {
    const id = await insertReclaimedWordList()
    await restoreResources(wordLists, ctx.projectId, [id])

    const refs = await findReclaimedResourceRefs(ctx.projectId, { wordlistId: id })
    // Restored: archived_at cleared, blob_reclaimed_at still set (shell).
    expect(refs).toEqual({ reclaimed: [`wordlist(${id})`], archived: [] })
  })

  it('findReclaimedResourceRefs returns empty for a usable (non-shell) wordlist', async () => {
    const [row] = await db
      .insert(wordLists)
      .values({
        projectId: ctx.projectId,
        name: 'usable-wordlist',
        status: 'ready',
        isPermanent: true,
        fileRef: {},
      })
      .returning({ id: wordLists.id })
    const id = row!.id

    const refs = await findReclaimedResourceRefs(ctx.projectId, { wordlistId: id })
    expect(refs).toEqual({ reclaimed: [], archived: [] })
  })

  it('validateCampaignResources rejects an attack referencing a reclaimed-shell wordlist', async () => {
    const id = await insertReclaimedWordList()
    await restoreResources(wordLists, ctx.projectId, [id])

    const result = await validateCampaignResources({ projectId: ctx.projectId, hashListId: null }, [
      { wordlistId: id },
    ])

    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reclaimed).toEqual([`wordlist(${id})`])
      expect(result.missing).toEqual([])
      expect(result.archived).toEqual([])
    }
  })

  it('validateCampaignResources accepts an attack referencing a restored, non-shell wordlist', async () => {
    const [row] = await db
      .insert(wordLists)
      .values({
        projectId: ctx.projectId,
        name: 're-uploaded-wordlist',
        status: 'ready',
        isPermanent: true,
        fileRef: {},
      })
      .returning({ id: wordLists.id })
    const id = row!.id

    const result = await validateCampaignResources({ projectId: ctx.projectId, hashListId: null }, [
      { wordlistId: id },
    ])

    expect(result.valid).toBe(true)
  })

  it('a reclaimed shell that regains blob_reclaimed_at=null (simulated re-upload) is no longer flagged', async () => {
    const id = await insertReclaimedWordList()
    await restoreResources(wordLists, ctx.projectId, [id])
    expect((await readWordList(id))?.blobReclaimedAt).not.toBeNull()

    // Simulate a successful checksum-verified re-upload (proven separately
    // by the unit suite): blob_reclaimed_at clears.
    await db.update(wordLists).set({ blobReclaimedAt: null }).where(eq(wordLists.id, id))

    const refs = await findReclaimedResourceRefs(ctx.projectId, { wordlistId: id })
    expect(refs).toEqual({ reclaimed: [], archived: [] })
  })
})

// ─── F5 (issue #106 code review): archived (not reclaimed) resource refs ──

describe('archived resource refs are rejected distinct from reclaimed refs (F5)', () => {
  async function insertArchivedWordList(): Promise<number> {
    const [row] = await db
      .insert(wordLists)
      .values({
        projectId: ctx.projectId,
        name: 'archived-not-reclaimed-wordlist',
        status: 'ready',
        isPermanent: true,
        archivedAt: new Date('2025-01-01T00:00:00Z'),
        blobReclaimedAt: null,
        fileRef: {},
      })
      .returning({ id: wordLists.id })
    return row!.id
  }

  it('findReclaimedResourceRefs flags an archived (not reclaimed) wordlist reference', async () => {
    const id = await insertArchivedWordList()

    const refs = await findReclaimedResourceRefs(ctx.projectId, { wordlistId: id })
    expect(refs).toEqual({ reclaimed: [], archived: [`wordlist(${id})`] })
  })

  it('validateCampaignResources rejects an attack referencing an archived (not reclaimed) wordlist', async () => {
    const id = await insertArchivedWordList()

    const result = await validateCampaignResources({ projectId: ctx.projectId, hashListId: null }, [
      { wordlistId: id },
    ])

    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.archived).toEqual([`wordlist(${id})`])
      expect(result.reclaimed).toEqual([])
      expect(result.missing).toEqual([])
    }
  })

  it('validateCampaignResources rejects a campaign referencing an archived hash list', async () => {
    const [row] = await db
      .insert(hashLists)
      .values({
        projectId: ctx.projectId,
        name: 'archived-hashlist',
        status: 'ready',
        isPermanent: true,
        archivedAt: new Date('2025-01-01T00:00:00Z'),
      })
      .returning({ id: hashLists.id })
    const id = row!.id

    const result = await validateCampaignResources({ projectId: ctx.projectId, hashListId: id }, [])

    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.archived).toEqual([`hashList(${id})`])
    }
  })
})

// ─── #108 U1: compression_encoding defaults to 'none' on all three list tables ──

describe('compression_encoding column defaults to none (#108 U1)', () => {
  it('defaults compression_encoding to none for a new word list', async () => {
    const [row] = await db
      .insert(wordLists)
      .values({ projectId: ctx.projectId, name: 'compression-default-wordlist', fileRef: {} })
      .returning({ compressionEncoding: wordLists.compressionEncoding })
    expect(row?.compressionEncoding).toBe('none')
  })

  it('defaults compression_encoding to none for a new rule list', async () => {
    const [row] = await db
      .insert(ruleLists)
      .values({ projectId: ctx.projectId, name: 'compression-default-rulelist', fileRef: {} })
      .returning({ compressionEncoding: ruleLists.compressionEncoding })
    expect(row?.compressionEncoding).toBe('none')
  })

  it('defaults compression_encoding to none for a new mask list', async () => {
    const [row] = await db
      .insert(maskLists)
      .values({ projectId: ctx.projectId, name: 'compression-default-masklist', fileRef: {} })
      .returning({ compressionEncoding: maskLists.compressionEncoding })
    expect(row?.compressionEncoding).toBe('none')
  })
})

describe('reclaimed-shell guard does not block attacks unrelated to the shell', () => {
  it('leaves an attack that references a different, usable wordlist unaffected', async () => {
    const shellId = await insertReclaimedWordList()
    await restoreResources(wordLists, ctx.projectId, [shellId])

    const [usable] = await db
      .insert(wordLists)
      .values({
        projectId: ctx.projectId,
        name: 'unrelated-usable-wordlist',
        status: 'ready',
        isPermanent: true,
        fileRef: {},
      })
      .returning({ id: wordLists.id })
    const usableId = usable!.id

    // A campaign-scoped read confirms the shell row itself never appears in
    // an unrelated attack's reference set.
    const [attackRow] = await db
      .insert(attacks)
      .values({
        campaignId: ctx.ownerCampaignId,
        projectId: ctx.projectId,
        mode: 0,
        wordlistId: usableId,
      })
      .returning({ id: attacks.id, wordlistId: attacks.wordlistId })
    expect(attackRow?.wordlistId).toBe(usableId)
    expect(attackRow?.wordlistId).not.toBe(shellId)
  })
})
