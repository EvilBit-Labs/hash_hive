/**
 * Real-DB tests for the chunked-upload compression worker (issue #108 U4).
 *
 * Unlike the direct-upload path (U2/U3, proven in
 * `tests/unit/services/resources-upload.test.ts`), a chunked upload streams
 * parts straight to S3 without ever buffering the file server-side -- there
 * is no in-memory buffer to gzip or hash inline. `compressChunkedResourceObject`
 * is the background pass that does both, in ONE streaming download of the
 * object that has already landed in storage.
 *
 * CI's `test:db` job provisions Postgres only -- no S3/SeaweedFS/MinIO --
 * so, per repo convention (see `blob-reclamation.db.test.ts`), storage is
 * never hit for real here. `compressChunkedResourceObject` accepts an
 * injectable `CompressionStorageDeps` boundary specifically for this; these
 * tests inject a small in-memory `Map`-backed fake object store instead of
 * mocking a module (module mocks leak process-wide across `bun:test`
 * files -- see GOTCHAS.md). The fake still exercises the service's real
 * streaming/hashing/multipart logic end to end: raw checksum over the
 * streamed bytes, gzip-if-smaller, keep-raw-if-not, delete-of-the-discarded
 * original, idempotency, and the mid-stream non-final-part failure path --
 * only the S3 wire calls themselves are replaced.
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
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import type { CompressionStorageDeps } from '../../src/services/resources/resource-compression.js'

import { db } from '../../src/db/index.js'
import { compressChunkedResourceObject } from '../../src/services/resources/resource-compression.js'

const TEST_SLUG = 'resource-compression-worker-db-test-proj'

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function blobKeyForChecksum(checksum: string): string {
  return `blobs/${checksum}`
}

// ─── In-memory fake object store ────────────────────────────────────────
//
// Stands in for S3/SeaweedFS: a `Map<key, Buffer>` for landed objects, plus
// a `Map<uploadId, ...>` tracking in-flight multipart uploads. Mirrors just
// enough of the real `@aws-sdk/client-s3` response shape
// (`response.Body.transformToWebStream()` /
// `response.Body.transformToByteArray()`) for the service and this file's
// own read-back helpers to consume identically to real storage.

interface FakeMultipartUpload {
  key: string
  parts: Map<number, Buffer>
}

const fakeObjects = new Map<string, Buffer>()
const fakeUploads = new Map<string, FakeMultipartUpload>()

interface FakeBody {
  transformToByteArray: () => Promise<Uint8Array>
  transformToWebStream: () => ReadableStream<Uint8Array>
}

const FAKE_STREAM_CHUNK_BYTES = 64 * 1024

function makeFakeBody(buffer: Buffer): FakeBody {
  return {
    transformToByteArray: () => Promise.resolve(new Uint8Array(buffer)),
    transformToWebStream: () => {
      let offset = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= buffer.byteLength) {
            controller.close()
            return
          }
          const end = Math.min(offset + FAKE_STREAM_CHUNK_BYTES, buffer.byteLength)
          controller.enqueue(new Uint8Array(buffer.subarray(offset, end)))
          offset = end
        },
      })
    },
  }
}

function fakePutObject(key: string, body: Buffer): void {
  fakeObjects.set(key, body)
}

async function fakeDownloadFile(key: string): Promise<{ Body: FakeBody }> {
  const buffer = fakeObjects.get(key)
  if (!buffer) {
    throw new Error(`fake object store: NoSuchKey "${key}"`)
  }
  return { Body: makeFakeBody(buffer) }
}

async function fakeDeleteFile(key: string): Promise<void> {
  fakeObjects.delete(key)
}

async function fakeCreateMultipartUpload(key: string): Promise<string> {
  const uploadId = randomUUID()
  fakeUploads.set(uploadId, { key, parts: new Map() })
  return uploadId
}

async function fakeUploadPart(
  _key: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array
): Promise<string> {
  const upload = fakeUploads.get(uploadId)
  if (!upload) {
    throw new Error(`fake object store: no such multipart upload "${uploadId}"`)
  }
  upload.parts.set(partNumber, Buffer.from(body))
  return `fake-etag-${partNumber}`
}

async function fakeCompleteMultipartUpload(
  _key: string,
  uploadId: string,
  parts: ReadonlyArray<{ partNumber: number; etag: string }>
): Promise<void> {
  const upload = fakeUploads.get(uploadId)
  if (!upload) {
    throw new Error(`fake object store: no such multipart upload "${uploadId}"`)
  }
  const assembled = [...parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => {
      const partBuffer = upload.parts.get(p.partNumber)
      if (!partBuffer) {
        throw new Error(`fake object store: missing part ${p.partNumber} on complete`)
      }
      return partBuffer
    })
  fakeObjects.set(upload.key, Buffer.concat(assembled))
  fakeUploads.delete(uploadId)
}

async function fakeAbortMultipartUpload(_key: string, uploadId: string): Promise<void> {
  fakeUploads.delete(uploadId)
}

/**
 * Fakes for the content-addressed dedup boundary (issue #108 follow-up):
 * `headObject` answers "does `blobs/<checksum>` already exist" from the same
 * `fakeObjects` Map every other fake reads/writes, and `copyObject` performs
 * a server-side-style copy within that Map. Both must be injected here (not
 * left to fall back to the real `config/storage.js` defaults) — this test
 * file runs under `just test-db`, which provisions Postgres only, no
 * SeaweedFS/S3.
 */
async function fakeHeadObject(key: string): Promise<{ exists: boolean; size?: number }> {
  const buffer = fakeObjects.get(key)
  return buffer ? { exists: true, size: buffer.byteLength } : { exists: false }
}

async function fakeCopyObject(sourceKey: string, destKey: string): Promise<void> {
  const buffer = fakeObjects.get(sourceKey)
  if (!buffer) {
    throw new Error(`fake object store: NoSuchKey "${sourceKey}" (copyObject source)`)
  }
  fakeObjects.set(destKey, buffer)
}

/**
 * The full fake storage boundary, satisfying `CompressionStorageDeps`. Each
 * test either passes this straight through (happy paths) or spreads it and
 * overrides one function to inject a failure -- exactly mirroring how the
 * real defaults are used in production, just backed by `Map`s instead of a
 * network call.
 */
const defaultDeps = {
  downloadFile: fakeDownloadFile,
  deleteFile: fakeDeleteFile,
  createMultipartUpload: fakeCreateMultipartUpload,
  uploadPart: fakeUploadPart,
  completeMultipartUpload: fakeCompleteMultipartUpload,
  abortMultipartUpload: fakeAbortMultipartUpload,
  headObject: fakeHeadObject,
  copyObject: fakeCopyObject,
} as unknown as CompressionStorageDeps

async function fetchStoredBytes(key: string): Promise<Buffer> {
  const response = await fakeDownloadFile(key)
  const bytes = await response.Body.transformToByteArray()
  return Buffer.from(bytes)
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await fakeDownloadFile(key)
    return true
  } catch {
    return false
  }
}

let projectId: number

/**
 * Simulates "a chunked upload for this resource has just completed": PUTs
 * the raw bytes into the fake object store (standing in for the multipart
 * upload's landed object) and inserts a resource row pointing at it with
 * `file_checksum: null` -- exactly the state `completeChunkedUpload` leaves
 * for a normal (non-restore) completion.
 */
async function insertCompletedChunkedWordList(content: Buffer): Promise<{
  id: number
  key: string
}> {
  const key = `${projectId}/wordlists/${randomUUID()}`
  fakePutObject(key, content)
  const [row] = await db
    .insert(wordLists)
    .values({
      projectId,
      name: 'compression-worker-test-wordlist',
      status: 'ready',
      fileChecksum: null,
      fileSize: content.byteLength,
      compressionEncoding: 'none',
      fileRef: {
        key,
        contentType: 'text/plain',
        size: content.byteLength,
        name: 'wordlist.txt',
        uploadedAt: new Date().toISOString(),
      },
    })
    .returning({ id: wordLists.id })
  return { id: row!.id, key }
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

describe('compressChunkedResourceObject (#108 U4)', () => {
  it('compresses a compressible object, records the raw checksum/size, and deletes the original', async () => {
    const content = Buffer.from('password123\nletmein\nqwerty\n'.repeat(500), 'utf8')
    const { id, key } = await insertCompletedChunkedWordList(content)

    const result = await compressChunkedResourceObject('wordlist', id, defaultDeps)

    expect(result.status).toBe('compressed')
    expect(result.rawBytes).toBe(content.byteLength)
    expect(result.checksum).toBe(sha256Hex(content))

    const row = await readWordList(id)
    expect(row?.compressionEncoding).toBe('gzip')
    expect(row?.fileChecksum).toBe(sha256Hex(content))
    expect(row?.fileSize).toBe(content.byteLength)

    // Content-addressed key (#108 dedup follow-up): the compressed temp
    // object is relocated onto the GLOBAL `blobs/<checksum>` key.
    const fileRef = row?.fileRef as { key?: string } | null
    expect(fileRef?.key).toBe(blobKeyForChecksum(sha256Hex(content)))
    expect(fileRef?.key).not.toBe(key)

    const storedBytes = await fetchStoredBytes(fileRef!.key!)
    expect(storedBytes.byteLength).toBeLessThan(content.byteLength)
    expect(gunzipSync(storedBytes)).toEqual(content)

    // The original raw object AND the temp compressed object are both
    // deleted once the content-addressed replacement is in place.
    expect(await objectExists(key)).toBe(false)
  })

  it('keeps a tiny/incompressible object raw, still recording checksum/size', async () => {
    const content = Buffer.from('x', 'utf8')
    const { id, key } = await insertCompletedChunkedWordList(content)

    const result = await compressChunkedResourceObject('wordlist', id, defaultDeps)

    expect(result.status).toBe('kept-raw')
    expect(result.checksum).toBe(sha256Hex(content))

    const row = await readWordList(id)
    expect(row?.compressionEncoding).toBe('none')
    expect(row?.fileChecksum).toBe(sha256Hex(content))
    expect(row?.fileSize).toBe(content.byteLength)

    // Content-addressed key (#108 dedup follow-up): the raw object itself
    // is relocated onto the GLOBAL `blobs/<checksum>` key, not left at its
    // temp per-upload key.
    const fileRef = row?.fileRef as { key?: string } | null
    expect(fileRef?.key).toBe(blobKeyForChecksum(sha256Hex(content)))
    expect(fileRef?.key).not.toBe(key)
    const storedBytes = await fetchStoredBytes(fileRef!.key!)
    expect(storedBytes).toEqual(content)

    // The original temp raw object is deleted once relocated.
    expect(await objectExists(key)).toBe(false)
  })

  it('is idempotent: a second run on an already-processed resource is a no-op', async () => {
    const content = Buffer.from('idempotent-content\n'.repeat(200), 'utf8')
    const { id } = await insertCompletedChunkedWordList(content)

    const first = await compressChunkedResourceObject('wordlist', id, defaultDeps)
    expect(first.status).toBe('compressed')
    const afterFirst = await readWordList(id)

    // A second run must not touch storage at all -- inject deps that would
    // fail the test if called.
    const second = await compressChunkedResourceObject('wordlist', id, {
      downloadFile: () => {
        throw new Error('downloadFile must not be called on an already-processed resource')
      },
    })

    expect(second.status).toBe('already-processed')
    expect(second.checksum).toBe(afterFirst?.fileChecksum ?? null)

    const afterSecond = await readWordList(id)
    expect(afterSecond?.fileChecksum).toBe(afterFirst?.fileChecksum ?? null)
    expect(afterSecond?.compressionEncoding).toBe(afterFirst?.compressionEncoding ?? null)
    expect(afterSecond?.fileRef).toEqual(afterFirst?.fileRef ?? null)
  })

  it('a simulated failure leaves the resource served raw and retriable', async () => {
    const content = Buffer.from('failure-path-content\n'.repeat(200), 'utf8')
    const { id, key } = await insertCompletedChunkedWordList(content)

    let abortCalled = false
    await expect(
      compressChunkedResourceObject('wordlist', id, {
        ...defaultDeps,
        uploadPart: () => Promise.reject(new Error('simulated S3 failure')),
        abortMultipartUpload: async (compressedKey: string, uploadId: string, bucket?: string) => {
          abortCalled = true
          await defaultDeps.abortMultipartUpload(compressedKey, uploadId, bucket)
        },
      })
    ).rejects.toThrow('simulated S3 failure')

    expect(abortCalled).toBe(true)

    // The row is untouched: still raw, still uncompressed, checksum still
    // unset -- a future retry of the same job is safe.
    const row = await readWordList(id)
    expect(row?.compressionEncoding).toBe('none')
    expect(row?.fileChecksum).toBeNull()
    const fileRef = row?.fileRef as { key?: string } | null
    expect(fileRef?.key).toBe(key)

    // The original object is untouched and still readable.
    const storedBytes = await fetchStoredBytes(key)
    expect(storedBytes).toEqual(content)

    // Retriable: a subsequent run without the injected failure succeeds.
    const retry = await compressChunkedResourceObject('wordlist', id, defaultDeps)
    expect(retry.status).toBe('compressed')
    const afterRetry = await readWordList(id)
    expect(afterRetry?.fileChecksum).toBe(sha256Hex(content))
  })

  it('does not hang when a non-final multipart part upload fails while the writer is backpressured', async () => {
    // Incompressible random bytes, comfortably over the 5MB non-final
    // part threshold once gzipped (gzip cannot shrink random data, so
    // compressed output tracks raw size) -- this reproduces the >5MB
    // condition under which a REAL non-final `uploadPart` call happens
    // (`flushPart(false)`), unlike the existing "simulated failure"
    // test above, which only rejects the FINAL `flushPart(true)` call
    // after the writer has already finished (content there is a few KB).
    const content = randomBytes(6 * 1024 * 1024)
    const { id, key } = await insertCompletedChunkedWordList(content)

    let abortCalled = false
    let firstPartAttempted = false
    await expect(
      compressChunkedResourceObject('wordlist', id, {
        ...defaultDeps,
        uploadPart: async (
          compressedKey: string,
          uploadId: string,
          partNum: number,
          partBody: Uint8Array,
          bucket?: string
        ) => {
          if (partNum === 1) {
            firstPartAttempted = true
            // Give the writer loop time to fill gzip's internal buffer
            // and actually park on `once(gzip, 'drain')` before this
            // rejection lands -- without the fix under test, that parked
            // writer promise (and the raw download stream underneath it)
            // would never settle, and this test would hang until
            // bun:test's timeout fails it.
            await new Promise((resolve) => setTimeout(resolve, 50))
            throw new Error('simulated S3 failure on first (non-final) part')
          }
          return defaultDeps.uploadPart(compressedKey, uploadId, partNum, partBody, bucket)
        },
        abortMultipartUpload: async (compressedKey: string, uploadId: string, bucket?: string) => {
          abortCalled = true
          await defaultDeps.abortMultipartUpload(compressedKey, uploadId, bucket)
        },
      })
    ).rejects.toThrow('simulated S3 failure on first (non-final) part')

    expect(firstPartAttempted).toBe(true)
    expect(abortCalled).toBe(true)

    // Same retriable-raw guarantee as the other failure-path test: the
    // row is untouched and the original object is still readable.
    const row = await readWordList(id)
    expect(row?.compressionEncoding).toBe('none')
    expect(row?.fileChecksum).toBeNull()
    const fileRef = row?.fileRef as { key?: string } | null
    expect(fileRef?.key).toBe(key)

    const storedBytes = await fetchStoredBytes(key)
    expect(storedBytes).toEqual(content)
  }, 20000)

  it('throws when the resource does not exist', async () => {
    await expect(compressChunkedResourceObject('wordlist', -1)).rejects.toThrow(/not found/i)
  })

  describe('content-addressed dedup (#108 follow-up)', () => {
    it('a second upload of identical raw content shares the blob and discards its own temp objects', async () => {
      const content = Buffer.from('dedup-content\n'.repeat(300), 'utf8')
      const first = await insertCompletedChunkedWordList(content)
      const second = await insertCompletedChunkedWordList(content)

      const firstResult = await compressChunkedResourceObject('wordlist', first.id, defaultDeps)
      expect(firstResult.status).toBe('compressed')

      // The second run must never attempt a server-side copy -- the guard
      // detects the blob already exists (from the first run) and dedups
      // instead of relocating anything.
      const copyObjectSpy = mock(fakeCopyObject)
      const secondResult = await compressChunkedResourceObject('wordlist', second.id, {
        ...defaultDeps,
        copyObject: copyObjectSpy,
      })

      expect(secondResult.status).toBe('compressed')
      expect(copyObjectSpy).not.toHaveBeenCalled()

      const rowA = await readWordList(first.id)
      const rowB = await readWordList(second.id)
      const keyA = (rowA?.fileRef as { key?: string } | null)?.key
      const keyB = (rowB?.fileRef as { key?: string } | null)?.key
      expect(keyA).toBe(blobKeyForChecksum(sha256Hex(content)))
      expect(keyB).toBe(keyA)
      // The second resource adopts the first's encoding rather than
      // recomputing/trusting its own -- both describe the one shared blob.
      expect(rowB?.compressionEncoding).toBe(rowA?.compressionEncoding)

      // Both resources' temp objects (raw + compressed) are gone -- only
      // the one shared content-addressed blob remains.
      expect(await objectExists(first.key)).toBe(false)
      expect(await objectExists(second.key)).toBe(false)
    })

    it('falls back to the temp compressed key (no dedup, no failure) when copyObject throws', async () => {
      const content = Buffer.from('copy-fallback-content\n'.repeat(300), 'utf8')
      const { id, key } = await insertCompletedChunkedWordList(content)

      const result = await compressChunkedResourceObject('wordlist', id, {
        ...defaultDeps,
        copyObject: () => Promise.reject(new Error('backend does not support server-side copy')),
      })

      expect(result.status).toBe('compressed')
      const row = await readWordList(id)
      const fileRef = row?.fileRef as { key?: string } | null
      // Falls back to the temp compressed key -- not content-addressed, but
      // still fully correct and servable; the job itself does not fail.
      expect(fileRef?.key).toBe(`${key}.gz`)
      expect(fileRef?.key).not.toBe(blobKeyForChecksum(sha256Hex(content)))

      const storedBytes = await fetchStoredBytes(fileRef!.key!)
      expect(gunzipSync(storedBytes)).toEqual(content)

      // The raw temp object is still deleted -- only the copy-to-`blobs/`
      // step was skipped, not the rest of the finalize.
      expect(await objectExists(key)).toBe(false)
    })
  })
})
