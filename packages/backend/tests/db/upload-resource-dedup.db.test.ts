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

import { db } from '../../src/db/index.js'
import { ChecksumMismatchError, uploadResourceFile } from '../../src/services/resources.js'

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
