/**
 * Real-DB (+ real object storage) tests for the chunked-upload compression
 * worker (issue #108 U4).
 *
 * Unlike the direct-upload path (U2/U3, proven in
 * `resource-upload-compression.db.test.ts`), a chunked upload streams parts
 * straight to S3 without ever buffering the file server-side -- there is no
 * in-memory buffer to gzip or hash inline. `compressChunkedResourceObject`
 * is the background pass that does both, in ONE streaming download of the
 * object that has already landed in storage. These tests simulate "a
 * chunked upload has just completed" by PUTting a raw object directly
 * (`uploadFile`) and inserting a resource row pointing at it with
 * `file_checksum: null` -- exactly the state `completeChunkedUpload` leaves
 * behind for a normal (non-restore) completion after issue #108 U4 removed
 * its own inline best-effort checksum capture.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). cleanupSeed() in
 * afterAll keeps runs idempotent and order-independent.
 *
 * NOTE: do NOT call client.end() here — harness.test.ts owns the shared
 * drizzle client lifecycle. NOTE: do NOT self-skip — test-db lane always has
 * Postgres AND SeaweedFS available.
 */

import { projects, wordLists } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import {
  abortMultipartUpload,
  downloadFile,
  uploadFile,
  uploadPart,
} from '../../src/config/storage.js'
import { db } from '../../src/db/index.js'
import { compressChunkedResourceObject } from '../../src/services/resources/resource-compression.js'

const TEST_SLUG = 'resource-compression-worker-db-test-proj'

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function fetchStoredBytes(key: string): Promise<Buffer> {
  const response = await downloadFile(key)
  const body = response.Body
  if (!body) throw new Error(`No object body for key ${key}`)
  const bytes = await body.transformToByteArray()
  return Buffer.from(bytes)
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await downloadFile(key)
    return true
  } catch {
    return false
  }
}

let projectId: number

/**
 * Simulates "a chunked upload for this resource has just completed": PUTs
 * the raw bytes directly (standing in for the multipart upload's landed
 * object) and inserts a resource row pointing at it with `file_checksum:
 * null` -- exactly the state `completeChunkedUpload` leaves for a normal
 * (non-restore) completion.
 */
async function insertCompletedChunkedWordList(content: Buffer): Promise<{
  id: number
  key: string
}> {
  const key = `${projectId}/wordlists/${randomUUID()}`
  await uploadFile(key, content, 'text/plain')
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
        // No explicit `bucket` — omitted so both `uploadFile` above and the
        // worker's `downloadFile` below resolve the same default
        // (`env.S3_BUCKET`, `hashhive-test` under the test env). Hardcoding
        // a literal bucket name here previously drifted from the test env's
        // actual bucket and produced a spurious NoSuchKey.
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

    const result = await compressChunkedResourceObject('wordlist', id)

    expect(result.status).toBe('compressed')
    expect(result.rawBytes).toBe(content.byteLength)
    expect(result.checksum).toBe(sha256Hex(content))

    const row = await readWordList(id)
    expect(row?.compressionEncoding).toBe('gzip')
    expect(row?.fileChecksum).toBe(sha256Hex(content))
    expect(row?.fileSize).toBe(content.byteLength)

    const fileRef = row?.fileRef as { key?: string } | null
    expect(fileRef?.key).toBeTruthy()
    expect(fileRef?.key).not.toBe(key)

    const storedBytes = await fetchStoredBytes(fileRef!.key!)
    expect(storedBytes.byteLength).toBeLessThan(content.byteLength)
    expect(gunzipSync(storedBytes)).toEqual(content)

    // The original raw object is deleted once the compressed replacement
    // is in place.
    expect(await objectExists(key)).toBe(false)
  })

  it('keeps a tiny/incompressible object raw, still recording checksum/size', async () => {
    const content = Buffer.from('x', 'utf8')
    const { id, key } = await insertCompletedChunkedWordList(content)

    const result = await compressChunkedResourceObject('wordlist', id)

    expect(result.status).toBe('kept-raw')
    expect(result.checksum).toBe(sha256Hex(content))

    const row = await readWordList(id)
    expect(row?.compressionEncoding).toBe('none')
    expect(row?.fileChecksum).toBe(sha256Hex(content))
    expect(row?.fileSize).toBe(content.byteLength)

    const fileRef = row?.fileRef as { key?: string } | null
    // The raw object's key is untouched -- nothing pointed away from it.
    expect(fileRef?.key).toBe(key)
    const storedBytes = await fetchStoredBytes(key)
    expect(storedBytes).toEqual(content)
  })

  it('is idempotent: a second run on an already-processed resource is a no-op', async () => {
    const content = Buffer.from('idempotent-content\n'.repeat(200), 'utf8')
    const { id } = await insertCompletedChunkedWordList(content)

    const first = await compressChunkedResourceObject('wordlist', id)
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
        uploadPart: () => Promise.reject(new Error('simulated S3 failure')),
        abortMultipartUpload: async (compressedKey: string, uploadId: string, bucket?: string) => {
          abortCalled = true
          await abortMultipartUpload(compressedKey, uploadId, bucket)
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
    const retry = await compressChunkedResourceObject('wordlist', id)
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
            // writer promise (and the raw S3 download stream underneath
            // it) would never settle, and this test would hang until
            // bun:test's timeout fails it.
            await new Promise((resolve) => setTimeout(resolve, 50))
            throw new Error('simulated S3 failure on first (non-final) part')
          }
          return uploadPart(compressedKey, uploadId, partNum, partBody, bucket)
        },
        abortMultipartUpload: async (compressedKey: string, uploadId: string, bucket?: string) => {
          abortCalled = true
          await abortMultipartUpload(compressedKey, uploadId, bucket)
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
})
