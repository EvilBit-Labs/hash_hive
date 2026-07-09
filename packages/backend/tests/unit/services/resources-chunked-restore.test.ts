/**
 * Service-level tests for chunked-upload restore-after-reclaim (issue #106
 * F3 code review / R12): `initiateChunkedUpload`'s `restoreResourceId`
 * path and `completeChunkedUpload`'s checksum verification against an
 * existing reclaimed-shell row.
 *
 * The route-level suite (`dashboard-resources-routes.test.ts`) fully mocks
 * `initiateChunkedUpload`/`completeChunkedUpload`, so it only proves the
 * HTTP error mapping. This file exercises the real service functions
 * against a mocked `db` + `config/storage.js` boundary — mirroring
 * `resources-upload.test.ts`'s existing pattern for `uploadResourceFile`'s
 * U12 checksum verification, but for the chunked-upload path, where the
 * checksum can only be verified AFTER the bytes already landed in S3
 * (there's no in-memory buffer to hash first).
 *
 * Because the db mock would leak process-wide, this file runs in an
 * isolated phase gated on `RESOURCES_CHUNKED_RESTORE_TEST_ISOLATED=1` (see
 * backend package.json `test` script).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'

function sha256Hex(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
}

/** Minimal S3 GetObjectCommandOutput-shaped stub `sha256HexFromObject` can stream. */
function fakeS3Body(content: string) {
  return {
    Body: {
      transformToWebStream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(content))
            controller.close()
          },
        }),
    },
  }
}

const IS_ISOLATED = process.env['RESOURCES_CHUNKED_RESTORE_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('resources-chunked-restore (skipped — runs in isolated phase)', () => {
    test('runs only with RESOURCES_CHUNKED_RESTORE_TEST_ISOLATED=1', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[resources-chunked-restore] skipped — set RESOURCES_CHUNKED_RESTORE_TEST_ISOLATED=1 to run; this suite mocks db so it must NOT run in the shared phase.'
      )
      expect(process.env['RESOURCES_CHUNKED_RESTORE_TEST_ISOLATED']).toBeUndefined()
    })
  })
}

if (IS_ISOLATED) {
  // ─── Mock audit-log recorder ───────────────────────────────────────────
  const recordAuditEvent = mock(async () => ({ id: 1 }))
  mock.module('../../../src/services/audit-log.js', () => ({
    recordAuditEvent,
  }))

  mock.module('../../../src/config/logger.js', () => ({
    logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
  }))

  // ─── Mock storage (S3) ──────────────────────────────────────────────────
  const createMultipartUpload = mock(async () => 'fake-s3-upload-id')
  const completeMultipartUpload = mock(async () => undefined)
  const deleteFile = mock(async () => undefined)
  let downloadFileImpl: () => Promise<ReturnType<typeof fakeS3Body>> = () =>
    Promise.resolve(fakeS3Body(''))
  const downloadFile = mock(() => downloadFileImpl())

  mock.module('../../../src/config/storage.js', () => ({
    abortMultipartUpload: mock(),
    completeMultipartUpload,
    createMultipartUpload,
    deleteFile,
    getPresignedUrl: mock(),
    listParts: mock(),
    uploadFile: mock(),
    uploadPart: mock(),
    downloadFile,
  }))

  // ─── Mock db ─────────────────────────────────────────────────────────
  //
  // A single mutable `currentRow` stands in for the resource row a
  // `select().from(table).where(...).limit(1)` would return. `lastUpdate`
  // captures whatever the most recent `update(table).set(values)` wrote
  // (both the plain and transactional paths), so tests can assert on the
  // final DB write without a full SQL-aware mock.
  let currentRow: Record<string, unknown> | null = null
  let lastUpdate: Record<string, unknown> | null = null
  const updateCalls: Array<Record<string, unknown>> = []

  function trackUpdate(values: Record<string, unknown>) {
    lastUpdate = values
    updateCalls.push(values)
    if (currentRow) currentRow = { ...currentRow, ...values }
  }

  mock.module('../../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(currentRow ? [currentRow] : []),
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            // Plain `await db.update(...).where(...)` (no `.returning()`)
            // path — used by initiateChunkedUpload's status/fileRef write
            // and completeChunkedUpload's non-restore write.
            // oxlint-disable-next-line no-thenable -- intentional Drizzle-style thenable query-builder mock
            then: (resolve: (v: unknown) => unknown) => {
              trackUpdate(values)
              resolve(undefined)
            },
            returning: () => {
              trackUpdate(values)
              return Promise.resolve(currentRow ? [currentRow] : [])
            },
          }),
        }),
      }),
      transaction: async (
        fn: (tx: {
          update: (table: unknown) => {
            set: (values: Record<string, unknown>) => {
              where: () => { returning: () => Promise<unknown[]> }
            }
          }
        }) => Promise<unknown>
      ) =>
        fn({
          update: () => ({
            set: (values: Record<string, unknown>) => ({
              where: () => ({
                returning: () => {
                  trackUpdate(values)
                  return Promise.resolve(currentRow ? [currentRow] : [])
                },
              }),
            }),
          }),
        }),
      delete: () => ({ where: () => Promise.resolve() }),
    },
  }))

  const { completeChunkedUpload, initiateChunkedUpload } =
    await import('../../../src/services/resources.js')
  const { ChecksumMismatchError, ResourceNotReclaimedShellError, UploadResourceNotFoundError } =
    await import('../../../src/services/resources.js')

  beforeEach(() => {
    currentRow = null
    lastUpdate = null
    updateCalls.length = 0
    recordAuditEvent.mockClear()
    createMultipartUpload.mockClear()
    completeMultipartUpload.mockClear()
    deleteFile.mockClear()
    downloadFile.mockClear()
    downloadFileImpl = () => Promise.resolve(fakeS3Body(''))
  })

  const USER_ACTOR = { actorType: 'user' as const, actorId: 7 }

  describe('initiateChunkedUpload — restoreResourceId (F3)', () => {
    test('reuses the existing reclaimed-shell row instead of creating a new one', async () => {
      currentRow = {
        id: 42,
        projectId: 7,
        blobReclaimedAt: new Date('2026-01-01T00:00:00Z'),
        fileChecksum: 'deadbeef',
        fileRef: {},
      }

      const result = await initiateChunkedUpload(
        {
          resourceType: 'wordlists',
          name: 'restore.txt',
          fileSize: 50_000_000,
          projectId: 7,
          restoreResourceId: 42,
        },
        USER_ACTOR
      )

      expect(result.resourceId).toBe(42)
      expect(createMultipartUpload).toHaveBeenCalledTimes(1)
      // The status/fileRef update targets the SAME row id — no new row insert.
      expect(lastUpdate).toMatchObject({ status: 'uploading' })
    })

    test('throws UploadResourceNotFoundError when restoreResourceId does not exist in project scope', async () => {
      currentRow = null

      await expect(
        initiateChunkedUpload({
          resourceType: 'wordlists',
          name: 'restore.txt',
          fileSize: 50_000_000,
          projectId: 7,
          restoreResourceId: 999,
        })
      ).rejects.toThrow(UploadResourceNotFoundError)
      expect(createMultipartUpload).not.toHaveBeenCalled()
    })

    test('throws ResourceNotReclaimedShellError when the target is not a reclaimed shell', async () => {
      currentRow = { id: 42, projectId: 7, blobReclaimedAt: null, fileChecksum: null, fileRef: {} }

      await expect(
        initiateChunkedUpload({
          resourceType: 'wordlists',
          name: 'restore.txt',
          fileSize: 50_000_000,
          projectId: 7,
          restoreResourceId: 42,
        })
      ).rejects.toThrow(ResourceNotReclaimedShellError)
      expect(createMultipartUpload).not.toHaveBeenCalled()
    })

    test('does not delete the reclaimed-shell row when S3 multipart initiation fails', async () => {
      currentRow = {
        id: 42,
        projectId: 7,
        blobReclaimedAt: new Date('2026-01-01T00:00:00Z'),
        fileChecksum: 'deadbeef',
        fileRef: {},
      }
      createMultipartUpload.mockImplementationOnce(() => Promise.reject(new Error('S3 down')))

      await expect(
        initiateChunkedUpload({
          resourceType: 'wordlists',
          name: 'restore.txt',
          fileSize: 50_000_000,
          projectId: 7,
          restoreResourceId: 42,
        })
      ).rejects.toThrow('S3 down')

      // No row delete/status update attempted for a restore session — the
      // shell is left exactly as it was, retry-safe.
      expect(updateCalls).toHaveLength(0)
    })
  })

  describe('completeChunkedUpload — reclaimed-shell checksum verification (F3)', () => {
    const parts = [{ partNumber: 1, etag: 'e' }]

    test('a matching checksum clears blob_reclaimed_at and records an audit event', async () => {
      const content = 'restored wordlist contents'
      currentRow = {
        id: 42,
        projectId: 7,
        blobReclaimedAt: new Date('2026-01-01T00:00:00Z'),
        fileChecksum: sha256Hex(content),
        fileRef: { key: 'k', bucket: 'b', fileSize: 100 },
      }
      downloadFileImpl = () => Promise.resolve(fakeS3Body(content))

      const result = await completeChunkedUpload('upload-1', parts, 42, 'wordlists', 7, USER_ACTOR)

      expect(result.resourceId).toBe(42)
      expect(completeMultipartUpload).toHaveBeenCalledTimes(1)
      expect(lastUpdate).toMatchObject({
        status: 'ready',
        fileChecksum: sha256Hex(content),
        blobReclaimedAt: null,
      })
      expect(recordAuditEvent).toHaveBeenCalledTimes(1)
      const [auditInput] = recordAuditEvent.mock.calls[0]!
      expect(auditInput.action).toBe('updated')
      expect(deleteFile).not.toHaveBeenCalled()
    })

    test('a mismatched checksum throws ChecksumMismatchError, leaves the shell untouched, and deletes the orphaned object', async () => {
      currentRow = {
        id: 42,
        projectId: 7,
        blobReclaimedAt: new Date('2026-01-01T00:00:00Z'),
        fileChecksum: sha256Hex('the-original-file-content'),
        fileRef: { key: 'k', bucket: 'b', fileSize: 100 },
      }
      downloadFileImpl = () => Promise.resolve(fakeS3Body('a-completely-different-file'))

      await expect(
        completeChunkedUpload('upload-1', parts, 42, 'wordlists', 7, USER_ACTOR)
      ).rejects.toThrow(ChecksumMismatchError)

      // No DB write landed — the row is still exactly the shell it was.
      expect(updateCalls).toHaveLength(0)
      expect(recordAuditEvent).not.toHaveBeenCalled()
      // Best-effort cleanup of the mismatched object that already landed in S3.
      expect(deleteFile).toHaveBeenCalledTimes(1)
      expect(deleteFile).toHaveBeenCalledWith('k', 'b')
    })

    test('a checksum-computation failure is treated as a rejection (fail closed), not a silent capture', async () => {
      currentRow = {
        id: 42,
        projectId: 7,
        blobReclaimedAt: new Date('2026-01-01T00:00:00Z'),
        fileChecksum: 'deadbeef',
        fileRef: { key: 'k', bucket: 'b', fileSize: 100 },
      }
      downloadFile.mockImplementationOnce(() => Promise.reject(new Error('S3 read failed')))

      await expect(
        completeChunkedUpload('upload-1', parts, 42, 'wordlists', 7, USER_ACTOR)
      ).rejects.toThrow(ChecksumMismatchError)

      expect(updateCalls).toHaveLength(0)
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })

    test('a normal (non-restore) completion no longer computes a checksum inline (issue #108 U4)', async () => {
      currentRow = {
        id: 2,
        projectId: 7,
        blobReclaimedAt: null,
        fileChecksum: null,
        fileRef: { key: 'k2', bucket: 'b', fileSize: 50 },
      }

      const result = await completeChunkedUpload('upload-2', parts, 2, 'wordlists', 7)

      expect(result.resourceId).toBe(2)
      expect(lastUpdate).toMatchObject({ status: 'ready' })
      expect(lastUpdate).not.toHaveProperty('fileChecksum')
      expect(lastUpdate).not.toHaveProperty('blobReclaimedAt')
      // The checksum used to be captured here via a second full download of
      // the object that had just finished uploading -- for the 100GB+ files
      // chunked upload exists to support, that redundant re-download is
      // wasteful. The resource-compression worker (#108 U4) is now the sole
      // authoritative source, so completion itself must not touch storage
      // at all for this path.
      expect(downloadFile).not.toHaveBeenCalled()
      // Not a restore — no audit event from this function (unchanged
      // pre-existing behavior; only the restore path is newly audited).
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })
  })
}
