/**
 * Real-DB tests for the blob-reclamation worker (issue #106 U11).
 *
 * Proves SQL-level behavior the mocked default lane cannot: the candidate
 * predicate (retention window, blob key, checksum, no active reference), the
 * atomic intent-stamp UPDATE, and — most importantly — the P0 restore-vs-
 * sweep TOCTOU race guard: a restore that clears `archived_at` between the
 * candidate SELECT and the stamp UPDATE must leave the row unreclaimed and
 * the blob untouched.
 *
 * `deleteFile`/storage is never mocked via `mock.module` (see GOTCHAS.md on
 * cross-file `mock.module` pollution in a shared `bun test` process) —
 * instead `reclaimExpiredResourceBlobs` accepts an injected `deleteBlob` spy
 * directly, and the TOCTOU race is proven via the injected `onBeforeStamp`
 * test hook rather than real concurrency.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). cleanupSeed() in
 * afterAll keeps runs idempotent and order-independent.
 *
 * NOTE: do NOT call client.end() here — harness.test.ts owns the shared
 * drizzle client lifecycle. NOTE: do NOT self-skip — test-db lane always has
 * Postgres available.
 */

import { attacks, auditLogs, campaigns, hashLists, projects, wordLists } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { reclaimExpiredResourceBlobs } from '../../src/queue/workers/blob-reclamation.js'
import { restoreResources } from '../../src/services/resources-archive.js'

const TEST_SLUG = 'blob-reclamation-db-test-proj'
/** Safely outside the 90-day default retention window. */
const OLD_ARCHIVED_AT = new Date(Date.now() - 120 * 24 * 60 * 60 * 1_000) // 120 days ago
/** Safely inside the default retention window. */
const RECENT_ARCHIVED_AT = new Date(Date.now() - 5 * 24 * 60 * 60 * 1_000) // 5 days ago

interface SeedCtx {
  projectId: number
  ownerCampaignId: number
}

let ctx: SeedCtx

async function insertWordList(overrides: {
  archivedAt?: Date | null
  blobReclaimedAt?: Date | null
  fileChecksum?: string | null
  hasBlobKey?: boolean
  isPermanent?: boolean
  key?: string
}): Promise<number> {
  const [row] = await db
    .insert(wordLists)
    .values({
      projectId: ctx.projectId,
      name: 'blob-reclamation-test-wordlist',
      status: 'ready',
      isPermanent: overrides.isPermanent ?? true,
      archivedAt: overrides.archivedAt ?? OLD_ARCHIVED_AT,
      blobReclaimedAt: overrides.blobReclaimedAt ?? null,
      fileChecksum: overrides.fileChecksum === undefined ? 'deadbeef' : overrides.fileChecksum,
      fileRef:
        overrides.hasBlobKey === false
          ? {}
          : {
              key: overrides.key ?? `${ctx.projectId}/wordlists/test-${Math.random()}.txt`,
              bucket: 'hashhive',
            },
    })
    .returning({ id: wordLists.id })
  return row!.id
}

async function insertAttack(wordlistId: number): Promise<number> {
  const [row] = await db
    .insert(attacks)
    .values({
      campaignId: ctx.ownerCampaignId,
      projectId: ctx.projectId,
      mode: 0,
      wordlistId,
    })
    .returning({ id: attacks.id })
  return row!.id
}

async function readWordList(id: number) {
  const [row] = await db
    .select({
      archivedAt: wordLists.archivedAt,
      blobReclaimedAt: wordLists.blobReclaimedAt,
    })
    .from(wordLists)
    .where(eq(wordLists.id, id))
  return row
}

async function readWordListKey(id: number): Promise<string | undefined> {
  const [row] = await db
    .select({ fileRef: wordLists.fileRef })
    .from(wordLists)
    .where(eq(wordLists.id, id))
  return (row?.fileRef as { key?: string } | null)?.key
}

async function cleanupSeed(): Promise<void> {
  // Project cascade removes wordLists/attacks/campaigns in one delete.
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
    .values({ projectId, name: 'blob-reclamation-owner-hashlist', status: 'ready' })
    .returning({ id: hashLists.id })
  const [ownerCampaign] = await db
    .insert(campaigns)
    .values({
      projectId,
      name: 'blob-reclamation-owner-campaign',
      hashListId: hl!.id,
      priority: 5,
      status: 'draft',
      // Single-hash-mode-per-campaign DB backstop (issue #100): must match
      // every attack `insertAttack` below inserts (mode 0) — see schema.ts's
      // `attacks_campaign_id_mode_..._fk`.
      hashcatMode: 0,
    })
    .returning({ id: campaigns.id })
  ctx = { projectId, ownerCampaignId: ownerCampaign!.id }
})

afterAll(cleanupSeed)

describe('reclaimExpiredResourceBlobs (U11, R11)', () => {
  it('reclaims a word list archived beyond the window with a blob and checksum', async () => {
    const id = await insertWordList({ archivedAt: OLD_ARCHIVED_AT })
    const deleteBlob = mock(() => Promise.resolve())

    const result = await reclaimExpiredResourceBlobs({ retention: '90 days', deleteBlob })

    expect(result.reclaimed).toBeGreaterThanOrEqual(1)
    expect(deleteBlob).toHaveBeenCalled()

    const row = await readWordList(id)
    expect(row?.blobReclaimedAt).not.toBeNull()
    // The row itself is retained (never deleted).
    expect(row).toBeDefined()

    const [auditRow] = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'word_list'), eq(auditLogs.entityId, id)))
    expect(auditRow?.action).toBe('reclaimed')
  })

  it('skips a resource archived within the retention window', async () => {
    const id = await insertWordList({ archivedAt: RECENT_ARCHIVED_AT })
    const deleteBlob = mock(() => Promise.resolve())

    await reclaimExpiredResourceBlobs({ retention: '90 days', deleteBlob })

    const row = await readWordList(id)
    expect(row?.blobReclaimedAt).toBeNull()
  })

  it('skips a resource with an active (non-archived) referencing attack', async () => {
    const id = await insertWordList({ archivedAt: OLD_ARCHIVED_AT })
    await insertAttack(id)
    const deleteBlob = mock(() => Promise.resolve())

    await reclaimExpiredResourceBlobs({ retention: '90 days', deleteBlob })

    const row = await readWordList(id)
    expect(row?.blobReclaimedAt).toBeNull()
    expect(deleteBlob).not.toHaveBeenCalled()
  })

  it('skips a resource with no blob key', async () => {
    const id = await insertWordList({ archivedAt: OLD_ARCHIVED_AT, hasBlobKey: false })
    const deleteBlob = mock(() => Promise.resolve())

    await reclaimExpiredResourceBlobs({ retention: '90 days', deleteBlob })

    const row = await readWordList(id)
    expect(row?.blobReclaimedAt).toBeNull()
    expect(deleteBlob).not.toHaveBeenCalled()
  })

  it('skips a resource with no captured file_checksum', async () => {
    const id = await insertWordList({ archivedAt: OLD_ARCHIVED_AT, fileChecksum: null })
    const deleteBlob = mock(() => Promise.resolve())

    await reclaimExpiredResourceBlobs({ retention: '90 days', deleteBlob })

    const row = await readWordList(id)
    expect(row?.blobReclaimedAt).toBeNull()
    expect(deleteBlob).not.toHaveBeenCalled()
  })

  it('does not reprocess an already-reclaimed row (idempotence)', async () => {
    await insertWordList({ archivedAt: OLD_ARCHIVED_AT, blobReclaimedAt: new Date() })
    const deleteBlob = mock(() => Promise.resolve())

    const result = await reclaimExpiredResourceBlobs({ retention: '90 days', deleteBlob })

    expect(deleteBlob).not.toHaveBeenCalled()
    // The pre-reclaimed row must not appear as a fresh reclaim in this run.
    expect(result.reclaimed).toBe(0)
  })

  it('logs and continues when deleteBlob throws — the stamp and audit event still land', async () => {
    const id = await insertWordList({ archivedAt: OLD_ARCHIVED_AT })
    const deleteBlob = mock(() => Promise.reject(new Error('S3 unavailable')))

    const result = await reclaimExpiredResourceBlobs({ retention: '90 days', deleteBlob })

    expect(result.reclaimed).toBeGreaterThanOrEqual(1)
    const row = await readWordList(id)
    // Stamp already committed before the (failing) delete attempt — best-effort.
    expect(row?.blobReclaimedAt).not.toBeNull()

    const [auditRow] = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'word_list'), eq(auditLogs.entityId, id)))
    expect(auditRow?.action).toBe('reclaimed')
  })

  describe('P0: restore-vs-sweep TOCTOU race', () => {
    it('does not reclaim a row restored between the candidate SELECT and the intent-stamp UPDATE', async () => {
      const id = await insertWordList({ archivedAt: OLD_ARCHIVED_AT })
      const deleteBlob = mock(() => Promise.resolve())

      const result = await reclaimExpiredResourceBlobs({
        retention: '90 days',
        deleteBlob,
        // Simulates a concurrent restore landing after this row was already
        // selected as a candidate but before the atomic stamp UPDATE runs.
        onBeforeStamp: async (row) => {
          if (row.id === id) {
            await restoreResources(wordLists, ctx.projectId, [id])
          }
        },
      })

      // The stamp UPDATE's WHERE re-validates archived_at IS NOT NULL, so the
      // restore (which cleared it) makes the UPDATE affect zero rows.
      expect(result.reclaimed).toBe(0)
      expect(deleteBlob).not.toHaveBeenCalled()

      const row = await readWordList(id)
      expect(row?.archivedAt).toBeNull()
      expect(row?.blobReclaimedAt).toBeNull()
    })

    it('does not reclaim a row that gains an active reference between SELECT and stamp', async () => {
      const id = await insertWordList({ archivedAt: OLD_ARCHIVED_AT })
      const deleteBlob = mock(() => Promise.resolve())

      const result = await reclaimExpiredResourceBlobs({
        retention: '90 days',
        deleteBlob,
        onBeforeStamp: async (row) => {
          if (row.id === id) {
            await insertAttack(id)
          }
        },
      })

      expect(result.reclaimed).toBe(0)
      expect(deleteBlob).not.toHaveBeenCalled()

      const row = await readWordList(id)
      expect(row?.blobReclaimedAt).toBeNull()
    })
  })

  describe('F6 (issue #106 code review): resilient sweep — one row failure does not abort the batch', () => {
    it('a thrown error reclaiming one candidate is logged and does not stop the other candidates in the same batch', async () => {
      const failingId = await insertWordList({ archivedAt: OLD_ARCHIVED_AT })
      const okId = await insertWordList({ archivedAt: OLD_ARCHIVED_AT })
      const deleteBlob = mock(() => Promise.resolve())

      const result = await reclaimExpiredResourceBlobs({
        retention: '90 days',
        deleteBlob,
        // Simulates an unexpected failure reclaiming one specific candidate
        // (e.g. a transient DB error inside the stamp+audit transaction).
        // The per-row try/catch in reclaimTableBlobs must catch this,
        // count it as an error, and continue on to the next candidate
        // rather than letting it abort the whole sweep.
        onBeforeStamp: async (row) => {
          if (row.id === failingId) {
            throw new Error('simulated transient failure')
          }
        },
      })

      expect(result.errors).toBeGreaterThanOrEqual(1)
      // The other candidate in the same batch still got reclaimed.
      expect(result.reclaimed).toBeGreaterThanOrEqual(1)

      const failingRow = await readWordList(failingId)
      expect(failingRow?.blobReclaimedAt).toBeNull()
      const [failingAudit] = await db
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(and(eq(auditLogs.entityType, 'word_list'), eq(auditLogs.entityId, failingId)))
      expect(failingAudit).toBeUndefined()

      const okRow = await readWordList(okId)
      expect(okRow?.blobReclaimedAt).not.toBeNull()
      const [okAudit] = await db
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(and(eq(auditLogs.entityType, 'word_list'), eq(auditLogs.entityId, okId)))
      expect(okAudit?.action).toBe('reclaimed')
    })
  })

  describe('shared-key guard (#108 safety foundation)', () => {
    it('reclaims (stamps) both rows sharing a key, but only physically deletes one blob', async () => {
      // Two rows sharing a physical blob key, both otherwise eligible for
      // reclamation. Whichever is processed first finds the other still
      // live and skips its physical delete; whichever is processed second
      // finds the first already stamped (dead) and proceeds. Order isn't
      // guaranteed, so the assertions below are order-independent: both
      // rows get stamped (reclamation always proceeds — the guard only
      // affects the blob delete), and the shared key is only ever passed to
      // `deleteBlob` once.
      const sharedKey = `${ctx.projectId}/wordlists/reclaim-shared-${Math.random()}.txt`
      const idA = await insertWordList({ archivedAt: OLD_ARCHIVED_AT, key: sharedKey })
      const idB = await insertWordList({ archivedAt: OLD_ARCHIVED_AT, key: sharedKey })
      const deleteBlob = mock(() => Promise.resolve())

      const result = await reclaimExpiredResourceBlobs({ retention: '90 days', deleteBlob })

      expect(result.reclaimed).toBeGreaterThanOrEqual(2)

      const rowA = await readWordList(idA)
      const rowB = await readWordList(idB)
      // Both rows are still reclaimed (stamped) — the guard only ever
      // skips the physical blob delete, never the row-level stamp.
      expect(rowA?.blobReclaimedAt).not.toBeNull()
      expect(rowB?.blobReclaimedAt).not.toBeNull()

      const calledKeys = deleteBlob.mock.calls.map(([key]) => key)
      // The shared key was physically deleted exactly once, not twice.
      expect(calledKeys.filter((key) => key === sharedKey)).toHaveLength(1)
    })

    it('physically deletes both blobs once each has its own unique key', async () => {
      const idA = await insertWordList({ archivedAt: OLD_ARCHIVED_AT })
      const idB = await insertWordList({ archivedAt: OLD_ARCHIVED_AT })
      const [keyA, keyB] = await Promise.all([readWordListKey(idA), readWordListKey(idB)])
      const deleteBlob = mock(() => Promise.resolve())

      const result = await reclaimExpiredResourceBlobs({ retention: '90 days', deleteBlob })

      expect(result.reclaimed).toBeGreaterThanOrEqual(2)

      const rowA = await readWordList(idA)
      const rowB = await readWordList(idB)
      expect(rowA?.blobReclaimedAt).not.toBeNull()
      expect(rowB?.blobReclaimedAt).not.toBeNull()

      const calledKeys = deleteBlob.mock.calls.map(([key]) => key)
      expect(calledKeys).toContain(keyA)
      expect(calledKeys).toContain(keyB)
    })
  })
})
