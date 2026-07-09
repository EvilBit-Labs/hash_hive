/**
 * Real-DB (+ real object storage) tests for direct-upload compression and
 * raw-checksum capture (issue #108 U2/U3).
 *
 * Exercises `uploadResourceFile` against the live Postgres test database AND
 * the live SeaweedFS (S3-compatible) store configured by
 * `tests/preload-db.ts` — proving the full round trip: the object landing in
 * storage decompresses back to the exact original bytes, `file_checksum` is
 * the SHA-256 of the RAW (pre-compression) file, and `file_size` is the raw
 * byte count regardless of which encoding a given upload happened to pick.
 *
 * The reclaimed-shell checksum-mismatch rejection (throws before any bytes
 * reach storage) is proven against a mocked storage layer in
 * `tests/unit/services/resources-upload.test.ts` — asserting "no object
 * landed in storage" is not practical here without mocking, which this real
 * storage/DB lane deliberately avoids (see GOTCHAS.md). This file instead
 * proves the *match* half of that flow end-to-end, including compression.
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
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { downloadFile } from '../../src/config/storage.js'
import { db } from '../../src/db/index.js'
import { uploadResourceFile } from '../../src/services/resources.js'

const TEST_SLUG = 'resource-upload-compression-db-test-proj'

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

let projectId: number

async function insertPendingWordList(name: string): Promise<number> {
  const [row] = await db
    .insert(wordLists)
    .values({ projectId, name, status: 'pending', fileRef: {} })
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

describe('uploadResourceFile - direct-upload compression + raw checksum (#108 U2/U3)', () => {
  it('stores a compressible wordlist gzip-encoded; the stored blob gunzips to the exact original', async () => {
    const id = await insertPendingWordList('compression-gzip-wordlist')
    const content = 'password123\nletmein\nqwerty\n'.repeat(500)
    const buffer = Buffer.from(content, 'utf8')
    const file = new File([buffer], 'wordlist.txt', { type: 'text/plain' })

    const result = await uploadResourceFile(wordLists, id, projectId, 'wordlists', file)
    expect(result.size).toBe(buffer.byteLength)

    const row = await readWordList(id)
    expect(row?.compressionEncoding).toBe('gzip')
    expect(row?.fileChecksum).toBe(sha256Hex(buffer))
    expect(row?.fileSize).toBe(buffer.byteLength) // raw size, not the compressed size

    const fileRef = row?.fileRef as { key?: string } | null
    expect(fileRef?.key).toBeTruthy()
    const storedBytes = await fetchStoredBytes(fileRef!.key!)
    // The bytes at rest are smaller than the original (actually gzipped)...
    expect(storedBytes.byteLength).toBeLessThan(buffer.byteLength)
    // ...and gunzip exactly reproduces the original upload.
    expect(gunzipSync(storedBytes)).toEqual(buffer)
  })

  it('stores a tiny/incompressible file as-is with encoding none, and the raw checksum matches', async () => {
    const id = await insertPendingWordList('compression-none-wordlist')
    const content = 'x'
    const buffer = Buffer.from(content, 'utf8')
    const file = new File([buffer], 'wordlist.txt', { type: 'text/plain' })

    await uploadResourceFile(wordLists, id, projectId, 'wordlists', file)

    const row = await readWordList(id)
    expect(row?.compressionEncoding).toBe('none')
    expect(row?.fileChecksum).toBe(sha256Hex(buffer))
    expect(row?.fileSize).toBe(buffer.byteLength)

    const fileRef = row?.fileRef as { key?: string } | null
    const storedBytes = await fetchStoredBytes(fileRef!.key!)
    // Stored verbatim -- no gzip magic header (1f 8b).
    expect(storedBytes).toEqual(buffer)
  })

  it('a reclaimed-shell re-upload with a matching checksum clears blob_reclaimed_at and round-trips through storage', async () => {
    const content = 'restore-me\n'.repeat(300)
    const buffer = Buffer.from(content, 'utf8')
    const originalChecksum = sha256Hex(buffer)

    const [row] = await db
      .insert(wordLists)
      .values({
        projectId,
        name: 'compression-restore-wordlist',
        status: 'ready',
        isPermanent: true,
        blobReclaimedAt: new Date('2026-01-01T00:00:00Z'),
        fileChecksum: originalChecksum,
        fileRef: {},
      })
      .returning({ id: wordLists.id })
    const id = row!.id

    const file = new File([buffer], 'wordlist.txt', { type: 'text/plain' })
    await uploadResourceFile(wordLists, id, projectId, 'wordlists', file)

    const updated = await readWordList(id)
    expect(updated?.blobReclaimedAt).toBeNull()
    expect(updated?.fileChecksum).toBe(originalChecksum)

    const fileRef = updated?.fileRef as { key?: string } | null
    const storedBytes = await fetchStoredBytes(fileRef!.key!)
    const decoded = updated?.compressionEncoding === 'gzip' ? gunzipSync(storedBytes) : storedBytes
    expect(decoded).toEqual(buffer)
  })

  it('a reclaimed-shell re-upload with a mismatched checksum is rejected and leaves the shell untouched', async () => {
    const [row] = await db
      .insert(wordLists)
      .values({
        projectId,
        name: 'compression-mismatch-wordlist',
        status: 'ready',
        isPermanent: true,
        blobReclaimedAt: new Date('2026-01-01T00:00:00Z'),
        fileChecksum: sha256Hex(Buffer.from('the-original-file-content')),
        fileRef: {},
      })
      .returning({ id: wordLists.id })
    const id = row!.id

    const file = new File([Buffer.from('a-completely-different-file')], 'wordlist.txt', {
      type: 'text/plain',
    })

    await expect(uploadResourceFile(wordLists, id, projectId, 'wordlists', file)).rejects.toThrow(
      /reclaimed shell/i
    )

    const untouched = await readWordList(id)
    expect(untouched?.blobReclaimedAt).not.toBeNull()
    expect(untouched?.fileChecksum).toBe(sha256Hex(Buffer.from('the-original-file-content')))
  })
})
