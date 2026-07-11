/**
 * Real-DB tests for content-addressed blob dedup on the direct-upload path
 * (issue #108 follow-up: `uploadResourceFile` in `services/resources.ts`).
 *
 * The blob now lives at a GLOBAL key `blobs/<rawChecksum>` instead of a
 * random per-resource UUID, so identical raw content uploaded by ANY
 * resource dedups onto the exact same physical object: the second upload
 * of the same bytes must skip the storage write entirely and adopt the
 * first upload's `compressionEncoding` rather than recomputing it.
 *
 * `uploadResourceFile` accepts an injectable `{ uploadFile, headObject }`
 * storage boundary (`UploadResourceStorageDeps`) specifically so this file
 * can exercise the real dedup decision against an in-memory fake object
 * store instead of hitting S3/SeaweedFS — `just test-db` provisions
 * Postgres only, per repo convention (see `resource-compression-worker.db.test.ts`).
 *
 * The trailing describe block below (#108 review Fix 5) closes a different
 * gap: `deleteBlobIfUnreferenced`'s "skip a still-shared blob, delete the
 * last reference" guard is already unit-tested directly
 * (`blob-lifecycle.db.test.ts`), but the `deleteResource` -> `cascadeDeleteResource`
 * -> `deleteBlobIfUnreferenced` WIRING (which `table` gets threaded through
 * per resource kind) was only implicitly covered. `deleteResource` now
 * accepts an injectable `{ deleteFile }` storage boundary
 * (`DeleteResourceStorageDeps`), mirroring `UploadResourceStorageDeps`, so
 * this suite can drive the full dedup -> delete -> survive/delete lifecycle
 * through the public API against the SAME in-memory fake store `upload`
 * writes to, without a production code path ever touching real storage.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). cleanupSeed() in
 * afterAll keeps runs idempotent and order-independent.
 *
 * NOTE: do NOT call client.end() here — harness.test.ts owns the shared
 * drizzle client lifecycle. NOTE: do NOT self-skip — test-db lane always has
 * Postgres available (storage is faked, see above, so it is never a
 * dependency of this file).
 */

import { projects, wordLists } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { db } from '../../src/db/index.js'
import {
  ChecksumMismatchError,
  deleteResource,
  uploadResourceFile,
} from '../../src/services/resources.js'
import { deleteBlobIfUnreferenced } from '../../src/services/resources/blob-lifecycle.js'

const TEST_SLUG = 'upload-resource-dedup-db-test-proj'

function sha256Hex(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
}

function blobKeyForChecksum(checksum: string): string {
  return `blobs/${checksum}`
}

// ─── In-memory fake object store ────────────────────────────────────────
//
// Stands in for S3/SeaweedFS: a `Map<key, Buffer>` for landed objects,
// matching `uploadResourceFile`'s injectable `UploadResourceStorageDeps`
// shape (`uploadFile` / `headObject`).

const fakeObjects = new Map<string, Buffer>()

async function fakeUploadFile(key: string, body: Buffer): Promise<void> {
  fakeObjects.set(key, Buffer.from(body))
}

async function fakeHeadObject(key: string): Promise<{ exists: boolean; size?: number }> {
  const buffer = fakeObjects.get(key)
  return buffer ? { exists: true, size: buffer.byteLength } : { exists: false }
}

async function fakeDeleteFile(key: string): Promise<void> {
  fakeObjects.delete(key)
}

function makeFile(content: string, name = 'wordlist.txt'): File {
  return new File([content], name, { type: 'text/plain' })
}

let projectId: number

async function insertWordList(overrides: {
  name?: string
  fileChecksum?: string | null
  blobReclaimedAt?: Date | null
}): Promise<number> {
  const [row] = await db
    .insert(wordLists)
    .values({
      projectId,
      name: overrides.name ?? `upload-dedup-test-wordlist-${Math.random()}`,
      status: 'ready',
      fileChecksum: overrides.fileChecksum === undefined ? null : overrides.fileChecksum,
      blobReclaimedAt: overrides.blobReclaimedAt ?? null,
    })
    .returning({ id: wordLists.id })
  return row!.id
}

async function readWordList(id: number) {
  const [row] = await db.select().from(wordLists).where(eq(wordLists.id, id))
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
  projectId = project!.id
})

afterAll(cleanupSeed)

describe('uploadResourceFile content-addressed dedup (#108 follow-up)', () => {
  it('a second upload of identical content dedups: shares the blob key, skips the storage write, adopts the encoding', async () => {
    // Long, highly repetitive content so the first upload actually compresses
    // (proving the second upload's encoding is ADOPTED, not independently
    // recomputed as a coincidental match).
    const content = 'alpha\nbravo\ncharlie\n'.repeat(200)
    const checksum = sha256Hex(content)
    const idA = await insertWordList({})
    const idB = await insertWordList({})

    const uploadFileA = mock(fakeUploadFile)
    const resultA = await uploadResourceFile(
      wordLists,
      idA,
      projectId,
      'wordlists',
      makeFile(content),
      undefined,
      { uploadFile: uploadFileA, headObject: fakeHeadObject }
    )
    expect(uploadFileA).toHaveBeenCalledTimes(1)
    expect(resultA.key).toBe(blobKeyForChecksum(checksum))

    const uploadFileB = mock(fakeUploadFile)
    const resultB = await uploadResourceFile(
      wordLists,
      idB,
      projectId,
      'wordlists',
      makeFile(content),
      undefined,
      { uploadFile: uploadFileB, headObject: fakeHeadObject }
    )

    // The dedup win: the second upload never writes to storage.
    expect(uploadFileB).not.toHaveBeenCalled()
    expect(resultB.key).toBe(blobKeyForChecksum(checksum))

    const rowA = await readWordList(idA)
    const rowB = await readWordList(idB)
    const keyA = (rowA?.fileRef as { key?: string } | null)?.key
    const keyB = (rowB?.fileRef as { key?: string } | null)?.key
    expect(keyA).toBe(blobKeyForChecksum(checksum))
    expect(keyB).toBe(keyA)
    expect(rowA?.fileChecksum).toBe(checksum)
    expect(rowB?.fileChecksum).toBe(checksum)
    // B adopts A's actual encoding rather than recomputing it.
    expect(rowB?.compressionEncoding).toBe(rowA?.compressionEncoding)
  })

  it('two uploads with distinct content land at two distinct content-addressed keys', async () => {
    const contentA = `distinct-content-a-${randomUUID()}`
    const contentB = `distinct-content-b-${randomUUID()}`
    const idA = await insertWordList({})
    const idB = await insertWordList({})

    const uploadFileFn = mock(fakeUploadFile)
    await uploadResourceFile(
      wordLists,
      idA,
      projectId,
      'wordlists',
      makeFile(contentA),
      undefined,
      {
        uploadFile: uploadFileFn,
        headObject: fakeHeadObject,
      }
    )
    await uploadResourceFile(
      wordLists,
      idB,
      projectId,
      'wordlists',
      makeFile(contentB),
      undefined,
      {
        uploadFile: uploadFileFn,
        headObject: fakeHeadObject,
      }
    )

    // Distinct content never dedups -- both uploads hit storage.
    expect(uploadFileFn).toHaveBeenCalledTimes(2)

    const rowA = await readWordList(idA)
    const rowB = await readWordList(idB)
    const keyA = (rowA?.fileRef as { key?: string } | null)?.key
    const keyB = (rowB?.fileRef as { key?: string } | null)?.key
    expect(keyA).toBe(blobKeyForChecksum(sha256Hex(contentA)))
    expect(keyB).toBe(blobKeyForChecksum(sha256Hex(contentB)))
    expect(keyA).not.toBe(keyB)
  })

  it('reclaimed-shell restore: a matching re-upload dedups onto the existing blob and clears blob_reclaimed_at', async () => {
    const content = `shell-restore-content-${randomUUID()}`
    const checksum = sha256Hex(content)

    // Seed an already-live resource holding this exact content, so the
    // shell's restore upload finds the blob already present (the realistic
    // shape of dedup: some OTHER resource got there first).
    const liveId = await insertWordList({})
    await uploadResourceFile(
      wordLists,
      liveId,
      projectId,
      'wordlists',
      makeFile(content),
      undefined,
      { uploadFile: mock(fakeUploadFile), headObject: fakeHeadObject }
    )

    const shellId = await insertWordList({
      fileChecksum: checksum,
      blobReclaimedAt: new Date('2026-01-01T00:00:00Z'),
    })

    const uploadFileFn = mock(fakeUploadFile)
    const result = await uploadResourceFile(
      wordLists,
      shellId,
      projectId,
      'wordlists',
      makeFile(content),
      undefined,
      { uploadFile: uploadFileFn, headObject: fakeHeadObject }
    )

    // Dedup: the shell's restore never re-writes the already-present blob.
    expect(uploadFileFn).not.toHaveBeenCalled()
    expect(result.key).toBe(blobKeyForChecksum(checksum))

    const shellRow = await readWordList(shellId)
    expect(shellRow?.blobReclaimedAt).toBeNull()
    expect(shellRow?.fileChecksum).toBe(checksum)
    const shellKey = (shellRow?.fileRef as { key?: string } | null)?.key
    expect(shellKey).toBe(blobKeyForChecksum(checksum))
  })

  it('a dedup hit with no live referencing row RE-UPLOADS the current deterministic representation instead of merely recomputing a label (#108 review Fix T)', async () => {
    // Long, highly repetitive content so it actually compresses -- proving
    // the recomputed encoding is 'gzip', not a coincidental match with the
    // old buggy 'none' default.
    const content = 'delta\necho\nfoxtrot\n'.repeat(200)
    const checksum = sha256Hex(content)
    const blobKey = blobKeyForChecksum(checksum)

    // Seed a row that lands this exact content, then mark it reclaimed so
    // NO live row references the blob key any more -- while the physical
    // blob is still present in storage (a prior reclaim-delete that failed
    // to clear the object, or a race with a concurrent upload). This is
    // exactly the state `findCompressionEncodingForKey` cannot resolve: it
    // scans only live (non-reclaimed) rows and returns null.
    const orphanId = await insertWordList({})
    await uploadResourceFile(
      wordLists,
      orphanId,
      projectId,
      'wordlists',
      makeFile(content),
      undefined,
      { uploadFile: mock(fakeUploadFile), headObject: fakeHeadObject }
    )
    await db
      .update(wordLists)
      .set({ blobReclaimedAt: new Date() })
      .where(eq(wordLists.id, orphanId))

    // Corrupt the physical bytes at the content-addressed key so this test
    // can PROVE the re-upload actually happened (not just that a label was
    // recomputed) -- if the fix regressed to "recompute the label only",
    // the stored bytes below would stay corrupted and mismatched.
    fakeObjects.set(blobKey, Buffer.from('stale-bytes-from-a-different-compression-policy'))

    const newId = await insertWordList({})
    const uploadFileFn = mock(fakeUploadFile)
    const result = await uploadResourceFile(
      wordLists,
      newId,
      projectId,
      'wordlists',
      makeFile(content),
      undefined,
      { uploadFile: uploadFileFn, headObject: fakeHeadObject }
    )

    // The dedup hit with no live row now RE-UPLOADS the current deterministic
    // representation, rather than silently trusting the (possibly stale)
    // bytes already at the key.
    expect(uploadFileFn).toHaveBeenCalledTimes(1)
    expect(result.key).toBe(blobKey)

    // The encoding is recomputed from the in-memory buffer, authoritatively
    // correct for this content -- never the buggy 'none' fallback that used
    // to fire whenever no live row could be found to adopt from.
    const newRow = await readWordList(newId)
    expect(newRow?.compressionEncoding).toBe('gzip')

    // The stored bytes now actually match the recorded encoding -- gunzip
    // recovers the exact original content, proving the re-upload replaced
    // the stale/mismatched bytes rather than leaving them in place.
    expect(gunzipSync(fakeObjects.get(blobKey)!).toString('utf8')).toBe(content)
  })

  it('reclaimed-shell restore: a mismatched re-upload is rejected before any storage write', async () => {
    const originalContent = `original-shell-content-${randomUUID()}`
    const shellId = await insertWordList({
      fileChecksum: sha256Hex(originalContent),
      blobReclaimedAt: new Date('2026-01-01T00:00:00Z'),
    })

    const uploadFileFn = mock(fakeUploadFile)
    const headObjectFn = mock(fakeHeadObject)

    await expect(
      uploadResourceFile(
        wordLists,
        shellId,
        projectId,
        'wordlists',
        makeFile('a-completely-different-file-body'),
        undefined,
        { uploadFile: uploadFileFn, headObject: headObjectFn }
      )
    ).rejects.toThrow(ChecksumMismatchError)

    // The mismatch is caught before ANY storage probe/write -- not just
    // before the upload.
    expect(uploadFileFn).not.toHaveBeenCalled()
    expect(headObjectFn).not.toHaveBeenCalled()

    // The row is left exactly as it was: still a shell, original checksum.
    const shellRow = await readWordList(shellId)
    expect(shellRow?.blobReclaimedAt).not.toBeNull()
    expect(shellRow?.fileChecksum).toBe(sha256Hex(originalContent))
  })
})

describe('dedup -> delete -> shared blob survives (#108 review Fix 5)', () => {
  it('deleting the first of two deduped resources skips the shared blob; deleting the second removes it', async () => {
    // Long, repetitive content so the upload actually compresses -- keeps
    // this aligned with the other dedup tests' content shape.
    const content = 'golf\nhotel\nindia\n'.repeat(200)
    const checksum = sha256Hex(content)
    const blobKey = blobKeyForChecksum(checksum)
    const idA = await insertWordList({})
    const idB = await insertWordList({})

    // Upload identical content twice through the real dedup decision: A
    // writes the blob, B dedups onto A's key without touching storage.
    const uploadFileA = mock(fakeUploadFile)
    await uploadResourceFile(wordLists, idA, projectId, 'wordlists', makeFile(content), undefined, {
      uploadFile: uploadFileA,
      headObject: fakeHeadObject,
    })
    const uploadFileB = mock(fakeUploadFile)
    await uploadResourceFile(wordLists, idB, projectId, 'wordlists', makeFile(content), undefined, {
      uploadFile: uploadFileB,
      headObject: fakeHeadObject,
    })
    expect(uploadFileA).toHaveBeenCalledTimes(1)
    expect(uploadFileB).not.toHaveBeenCalled()

    const rowA = await readWordList(idA)
    const rowB = await readWordList(idB)
    expect((rowA?.fileRef as { key?: string } | null)?.key).toBe(blobKey)
    expect((rowB?.fileRef as { key?: string } | null)?.key).toBe(blobKey)
    expect(fakeObjects.has(blobKey)).toBe(true)

    // Delete A (the first reference) via the PUBLIC deleteResource path --
    // this routes through cascadeDeleteResource -> deleteBlobIfUnreferenced
    // with `table: wordLists` threaded through. B still references the
    // same key, so the physical blob must survive.
    const deleteFileForA = mock(fakeDeleteFile)
    const resultA = await deleteResource(wordLists, idA, projectId, 'wordlist', undefined, {
      deleteFile: deleteFileForA,
    })
    expect(resultA.kind).toBe('deleted')
    expect(await readWordList(idA)).toBeUndefined()

    // The shared blob is NOT deleted -- B is still live and points at it.
    // deleteBlobIfUnreferenced's internal guard skips the physical delete,
    // so deleteFileForA is never actually invoked with this key.
    expect(fakeObjects.has(blobKey)).toBe(true)
    const survivor = await readWordList(idB)
    expect((survivor?.fileRef as { key?: string } | null)?.key).toBe(blobKey)
    // Still resolvable/downloadable: the fake object store still has bytes
    // at the key B's row points at.
    expect(fakeObjects.get(blobKey)).toBeDefined()

    // Delete B (the last remaining reference). No other live resource
    // shares the key any more, so this time the physical blob is actually
    // removed.
    const deleteFileForB = mock(fakeDeleteFile)
    const resultB = await deleteResource(wordLists, idB, projectId, 'wordlist', undefined, {
      deleteFile: deleteFileForB,
    })
    expect(resultB.kind).toBe('deleted')
    expect(await readWordList(idB)).toBeUndefined()
    expect(fakeObjects.has(blobKey)).toBe(false)
  })
})

describe('delete/adopt race is serialized by the per-blob-key advisory lock (#108 T12/T13)', () => {
  it('a guarded delete racing a same-content upload dedup decision never leaves a live row pointing at a missing blob', async () => {
    // The exact T13 scenario: resource A is the sole live reference to
    // blobKey K. A caller is mid-way through deleting/reclaiming A (its own
    // row is ALREADY stamped dead -- mirroring `blob-reclamation.ts`'s
    // `reclaimOne`, which stamps `blob_reclaimed_at` in its own transaction
    // BEFORE calling the guarded delete, and `cascadeDeleteResource`, which
    // deletes the owning row before calling it). Concurrently, a brand-new
    // resource B uploads the SAME raw content and tries to dedup onto K.
    //
    // Without `withBlobKeyLock` serializing the two critical sections, B's
    // `headObject(K)` could observe K still present (the delete hasn't
    // physically removed it yet), and — since A's row is already dead and
    // B's own row hasn't committed — `findCompressionEncodingForKey` would
    // find NO live referrer, hit the "no live row" branch, and (pre-fix)
    // adopt/keep the object without writing it. The delete would then
    // proceed to actually remove K (its scan already ran and found nothing
    // live), leaving B's about-to-commit row pointing at a blob that no
    // longer exists — silent data loss.
    //
    // This test proves the lock closes that window: B's entire
    // headObject-through-row-commit critical section is provably BLOCKED
    // (never even calls `headObject`) until the delete's own locked
    // transaction fully commits (physically removing K). Only then does B
    // proceed, observe K genuinely gone, and re-upload it -- so the
    // invariant "every live resource's blob physically exists" holds at
    // every point an outside observer could check it.
    const content = 'kilo\nlima\nmike\n'.repeat(200)
    const checksum = sha256Hex(content)
    const blobKey = blobKeyForChecksum(checksum)

    const idA = await insertWordList({})
    await uploadResourceFile(wordLists, idA, projectId, 'wordlists', makeFile(content), undefined, {
      uploadFile: mock(fakeUploadFile),
      headObject: fakeHeadObject,
    })
    expect(fakeObjects.has(blobKey)).toBe(true)
    // A's row is already dead by the time the guarded delete call happens,
    // matching every real call site's convention (see module docblock).
    await db.update(wordLists).set({ blobReclaimedAt: new Date() }).where(eq(wordLists.id, idA))

    const events: string[] = []

    // Gate controlling exactly when the delete's physical `deleteFn` (and
    // therefore its lock-holding transaction) is allowed to proceed, plus a
    // signal that resolves the instant the delete has entered its
    // lock-protected critical section (scan already passed "not shared").
    let releaseDelete: () => void = () => {
      throw new Error('releaseDelete invoked before being assigned')
    }
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve
    })
    let signalDeleteEntered: () => void = () => {
      throw new Error('signalDeleteEntered invoked before being assigned')
    }
    const deleteEntered = new Promise<void>((resolve) => {
      signalDeleteEntered = resolve
    })

    const hookedDeleteFn = async (key: string, bucket?: string): Promise<void> => {
      events.push('delete:enter')
      signalDeleteEntered()
      await deleteGate
      await fakeDeleteFile(key, bucket)
      events.push('delete:done')
    }

    // Start the delete. Do NOT await yet -- it will park on `deleteGate`
    // while still holding `withBlobKeyLock`'s transaction (and therefore
    // the advisory lock) open.
    const deletePromise = deleteBlobIfUnreferenced({
      table: wordLists,
      resourceId: idA,
      key: blobKey,
      deleteFn: hookedDeleteFn,
    })

    // Wait until the delete has genuinely entered its locked critical
    // section (scan complete, about to physically delete) before starting
    // the competing upload.
    await deleteEntered

    const idB = await insertWordList({})
    const headObjectSpy = mock(async (key: string) => {
      events.push('upload:headObject')
      return fakeHeadObject(key)
    })
    const uploadFileB = mock(fakeUploadFile)

    // Start the competing upload. Do NOT await yet.
    const uploadPromise = uploadResourceFile(
      wordLists,
      idB,
      projectId,
      'wordlists',
      makeFile(content),
      undefined,
      { uploadFile: uploadFileB, headObject: headObjectSpy }
    )

    // Prove B is genuinely blocked on the SAME advisory lock the delete
    // holds -- not merely slow -- by racing it against a timeout while the
    // gate is still closed. Without the lock, `headObjectSpy` would have
    // already been called by now (nothing in the old code path awaited
    // anything before it).
    const stillBlocked = await Promise.race([
      uploadPromise.then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still-blocked'), 150)),
    ])
    expect(stillBlocked).toBe('still-blocked')
    expect(headObjectSpy).not.toHaveBeenCalled()

    // Release the delete: its transaction commits (physically removing the
    // blob), and only THEN does B's transaction acquire the lock.
    releaseDelete()
    const deleteResult = await deletePromise
    expect(deleteResult).toEqual({ deleted: true })

    const uploadResult = await uploadPromise
    expect(uploadResult.key).toBe(blobKey)

    // Strict serialization, not a lucky interleave: the delete's physical
    // removal completed before B's dedup decision ever probed the key.
    expect(events).toEqual(['delete:enter', 'delete:done', 'upload:headObject'])

    // The invariant holds: B is now the sole live reference to `blobKey`,
    // and the blob genuinely exists again (B re-uploaded it after
    // observing it gone) -- never a live row pointing at nothing.
    expect(fakeObjects.has(blobKey)).toBe(true)
    expect(uploadFileB).toHaveBeenCalledTimes(1)
    const rowB = await readWordList(idB)
    expect((rowB?.fileRef as { key?: string } | null)?.key).toBe(blobKey)
    expect(rowB?.fileChecksum).toBe(checksum)
    expect(rowB?.compressionEncoding).toBe('gzip')
  })
})
