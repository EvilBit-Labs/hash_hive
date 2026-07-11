/**
 * Real-DB tests for `deleteBlobIfUnreferenced` (issue #108 safety foundation
 * for content-addressed blob storage).
 *
 * Proves the SQL-level "is any OTHER live resource still using this blob"
 * check the mocked default lane cannot: cross-table key matching against
 * word_lists/rule_lists/mask_lists, the `blob_reclaimed_at IS NULL` liveness
 * requirement (a reclaimed/dead sharer doesn't count), and the (table, id)
 * self-exclusion.
 *
 * The guard is purely KEY-based: two resources share a physical blob iff
 * they point at the same `fileRef.key`. Matching `fileChecksum` alone is
 * NOT sufficient to prove sharing -- identical content can (and today,
 * always does) live at two different keys, and deleting one must not be
 * blocked by the other merely having the same content.
 *
 * `deleteFile`/storage is never mocked via `mock.module` (see GOTCHAS.md on
 * cross-file `mock.module` pollution) — instead the helper's `deleteFn` is
 * injected directly per test, mirroring `blob-reclamation.db.test.ts`.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). cleanupSeed() in
 * afterAll keeps runs idempotent and order-independent.
 *
 * NOTE: do NOT call client.end() here — harness.test.ts owns the shared
 * drizzle client lifecycle. NOTE: do NOT self-skip — test-db lane always has
 * Postgres available.
 */

import { maskLists, projects, ruleLists, wordLists } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'

import { db } from '../../src/db/index.js'
import { deleteBlobIfUnreferenced } from '../../src/services/resources/blob-lifecycle.js'

const TEST_SLUG = 'blob-lifecycle-db-test-proj'

let projectId: number

async function insertWordList(overrides: {
  fileChecksum?: string | null
  blobReclaimedAt?: Date | null
  key?: string
}): Promise<{ id: number; key: string }> {
  const key = overrides.key ?? `${projectId}/wordlists/test-${Math.random()}.txt`
  const [row] = await db
    .insert(wordLists)
    .values({
      projectId,
      name: 'blob-lifecycle-test-wordlist',
      status: 'ready',
      isPermanent: true,
      blobReclaimedAt: overrides.blobReclaimedAt ?? null,
      fileChecksum: overrides.fileChecksum === undefined ? null : overrides.fileChecksum,
      fileRef: { key, bucket: 'hashhive' },
    })
    .returning({ id: wordLists.id })
  return { id: row!.id, key }
}

async function insertRuleList(overrides: {
  fileChecksum?: string | null
  blobReclaimedAt?: Date | null
  key?: string
}): Promise<{ id: number; key: string }> {
  const key = overrides.key ?? `${projectId}/rulelists/test-${Math.random()}.rule`
  const [row] = await db
    .insert(ruleLists)
    .values({
      projectId,
      name: 'blob-lifecycle-test-rulelist',
      status: 'ready',
      isPermanent: true,
      blobReclaimedAt: overrides.blobReclaimedAt ?? null,
      fileChecksum: overrides.fileChecksum === undefined ? null : overrides.fileChecksum,
      fileRef: { key, bucket: 'hashhive' },
    })
    .returning({ id: ruleLists.id })
  return { id: row!.id, key }
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
  projectId = project!.id
})

afterAll(cleanupSeed)

describe('deleteBlobIfUnreferenced (#108 safety foundation)', () => {
  it('deletes when the key is unique across all live resources', async () => {
    const a = await insertWordList({})
    const deleteFn = mock(() => Promise.resolve())

    const result = await deleteBlobIfUnreferenced({
      table: wordLists,
      resourceId: a.id,
      key: a.key,
      deleteFn,
    })

    expect(result).toEqual({ deleted: true })
    expect(deleteFn).toHaveBeenCalledTimes(1)
    expect(deleteFn).toHaveBeenCalledWith(a.key, undefined)
  })

  it('deletes when another LIVE resource shares the checksum but has a DIFFERENT key', async () => {
    // Same content, different physical blobs: matching checksum alone must
    // NOT block the delete. Only key-sharing identifies the same object.
    const checksum = `same-content-${Math.random()}`
    const a = await insertWordList({ fileChecksum: checksum })
    await insertWordList({ fileChecksum: checksum })
    const deleteFn = mock(() => Promise.resolve())

    const result = await deleteBlobIfUnreferenced({
      table: wordLists,
      resourceId: a.id,
      key: a.key,
      deleteFn,
    })

    expect(result).toEqual({ deleted: true })
    expect(deleteFn).toHaveBeenCalledTimes(1)
    expect(deleteFn).toHaveBeenCalledWith(a.key, undefined)
  })

  it('skips the physical delete when another LIVE resource shares the key', async () => {
    const sharedKey = `${projectId}/wordlists/shared-key-${Math.random()}.txt`
    const a = await insertWordList({ key: sharedKey })
    const b = await insertWordList({ key: sharedKey })
    const deleteFn = mock(() => Promise.resolve())

    const result = await deleteBlobIfUnreferenced({
      table: wordLists,
      resourceId: a.id,
      key: a.key,
      deleteFn,
    })

    expect(result).toEqual({ deleted: false, reason: 'shared' })
    expect(deleteFn).not.toHaveBeenCalled()

    // The sharer (b) is untouched by this call — only a's delete was guarded.
    expect(await readKey(wordLists, b.id)).toBe(sharedKey)
  })

  it('deletes when the only other resource sharing the key is already reclaimed (dead, not live)', async () => {
    const sharedKey = `${projectId}/wordlists/shared-dead-key-${Math.random()}.txt`
    const a = await insertWordList({ key: sharedKey })
    await insertWordList({ key: sharedKey, blobReclaimedAt: new Date() })
    const deleteFn = mock(() => Promise.resolve())

    const result = await deleteBlobIfUnreferenced({
      table: wordLists,
      resourceId: a.id,
      key: a.key,
      deleteFn,
    })

    expect(result).toEqual({ deleted: true })
    expect(deleteFn).toHaveBeenCalledTimes(1)
  })

  it('excludes the calling row itself from the "other live reference" scan', async () => {
    // A single row whose own key would otherwise "match itself" if the
    // self-exclusion were missing.
    const a = await insertWordList({})
    const deleteFn = mock(() => Promise.resolve())

    const result = await deleteBlobIfUnreferenced({
      table: wordLists,
      resourceId: a.id,
      key: a.key,
      deleteFn,
    })

    expect(result).toEqual({ deleted: true })
    expect(deleteFn).toHaveBeenCalledTimes(1)
  })

  it('checks for a shared key across tables (word_list + rule_list)', async () => {
    const sharedKey = `${projectId}/shared-cross-table-${Math.random()}`
    const wl = await insertWordList({ key: sharedKey })
    await insertRuleList({ key: sharedKey })
    const deleteFn = mock(() => Promise.resolve())

    const result = await deleteBlobIfUnreferenced({
      table: wordLists,
      resourceId: wl.id,
      key: wl.key,
      deleteFn,
    })

    expect(result).toEqual({ deleted: false, reason: 'shared' })
    expect(deleteFn).not.toHaveBeenCalled()
  })

  it('two resources sharing a content-addressed blob (#108 dedup): deleting one skips the physical delete, deleting the second then removes it', async () => {
    // The exact scenario content-addressed dedup introduces: two live
    // resources both point their `fileRef.key` at the SAME
    // `blobs/<checksum>` key because they uploaded identical raw content.
    // Deleting/reclaiming one must never destroy the blob the other still
    // needs; only once the second (and last) referencing row is gone does
    // the physical delete actually happen.
    const sharedBlobKey = `blobs/${createHash('sha256').update(`shared-content-${Math.random()}`).digest('hex')}`
    const a = await insertWordList({ key: sharedBlobKey })
    const b = await insertWordList({ key: sharedBlobKey })
    const deleteFn = mock(() => Promise.resolve())

    // Reclaim/delete `a` first: its OWN row is stamped dead before the
    // guarded blob delete runs, mirroring real call sites (`reclaimOne`
    // stamps `blob_reclaimed_at` inside its own transaction before calling
    // this guard; `cascadeDeleteResource` deletes the owning row before
    // calling it).
    await db.update(wordLists).set({ blobReclaimedAt: new Date() }).where(eq(wordLists.id, a.id))

    const firstResult = await deleteBlobIfUnreferenced({
      table: wordLists,
      resourceId: a.id,
      key: sharedBlobKey,
      deleteFn,
    })

    // b is still live and shares the key -- the physical delete is skipped.
    expect(firstResult).toEqual({ deleted: false, reason: 'shared' })
    expect(deleteFn).not.toHaveBeenCalled()
    expect(await readKey(wordLists, b.id)).toBe(sharedBlobKey)

    // Now reclaim/delete `b` too -- `a` is already dead, so no other live
    // resource references the shared key any more.
    await db.update(wordLists).set({ blobReclaimedAt: new Date() }).where(eq(wordLists.id, b.id))

    const secondResult = await deleteBlobIfUnreferenced({
      table: wordLists,
      resourceId: b.id,
      key: sharedBlobKey,
      deleteFn,
    })

    // No other live resource references the key any more -- the blob is
    // finally, physically deleted exactly once.
    expect(secondResult).toEqual({ deleted: true })
    expect(deleteFn).toHaveBeenCalledTimes(1)
    expect(deleteFn).toHaveBeenCalledWith(sharedBlobKey, undefined)
  })

  it('logs and swallows a deleteFn failure, returning reason "error"', async () => {
    const a = await insertWordList({})
    const deleteFn = mock(() => Promise.reject(new Error('S3 unavailable')))

    const result = await deleteBlobIfUnreferenced({
      table: wordLists,
      resourceId: a.id,
      key: a.key,
      deleteFn,
    })

    expect(result).toEqual({ deleted: false, reason: 'error' })
    expect(deleteFn).toHaveBeenCalledTimes(1)
  })
})

async function readKey(
  table: typeof wordLists | typeof ruleLists | typeof maskLists,
  id: number
): Promise<string | undefined> {
  const [row] = await db.select({ fileRef: table.fileRef }).from(table).where(eq(table.id, id))
  return (row?.fileRef as { key?: string } | null)?.key
}
