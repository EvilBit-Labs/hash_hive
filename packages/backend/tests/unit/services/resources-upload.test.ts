/**
 * Service-level tests for the direct-upload masklist sizing + keyspace fan-out
 * in `uploadResourceFile` (issue #231), and its reclaimed-shell checksum
 * verification (issue #106 U12).
 *
 * The route-level suite fully mocks `uploadResourceFile`, so the real sizing and
 * the fan-out *decision* are only exercised here. The discriminating case is an
 * UNCOMPUTABLE masklist: its keyspace persists as null AND the fan-out still
 * fires (a dependent attack is rewritten to null) — proving the direct-upload
 * path propagates null instead of leaving dependents on a stale value.
 *
 * The U12 block proves: a normal (non-shell) upload captures `fileChecksum`;
 * a reclaimed-shell re-upload with a matching checksum clears
 * `blobReclaimedAt` and calls `uploadFile`; a mismatched checksum throws
 * `ChecksumMismatchError` BEFORE `uploadFile` is ever called (so no bytes
 * reach storage) and the row is left untouched.
 *
 * Mocks only the lowest boundaries (logger, storage, db); `keyspace.js` and
 * `attacks/complexity.js` run for real so the count -> persist -> fan-out wiring
 * is genuinely exercised. Because the db mock would leak process-wide, this file
 * runs in an isolated phase gated on `RESOURCES_UPLOAD_TEST_ISOLATED=1` (see
 * backend package.json `test` script).
 */
import { attacks, maskLists, wordLists } from '@hashhive/shared'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

function sha256Hex(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
}

const IS_ISOLATED = process.env['RESOURCES_UPLOAD_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('resources-upload (skipped — runs in isolated phase)', () => {
    test('runs only with RESOURCES_UPLOAD_TEST_ISOLATED=1', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[resources-upload] skipped — set RESOURCES_UPLOAD_TEST_ISOLATED=1 to run; this suite mocks db so it must NOT run in the shared phase.'
      )
      // Assert the gate really is unset in this (shared) phase — i.e. the
      // DB-mocking suite is being skipped here, not running with its mocks
      // leaking process-wide. The console.warn above is what surfaces a dropped
      // isolated phase in CI logs (this stub passing means the real tests ran
      // only in their own RESOURCES_UPLOAD_TEST_ISOLATED=1 invocation).
      expect(process.env['RESOURCES_UPLOAD_TEST_ISOLATED']).toBeUndefined()
    })
  })
}

if (IS_ISOLATED) {
  // ─── Mock audit-log recorder (resources.ts now imports it) ────────────
  mock.module('../../../src/services/audit-log.js', () => ({
    recordAuditEvent: mock(async () => ({ id: 1 })),
  }))

  const warn = mock()
  mock.module('../../../src/config/logger.js', () => ({
    logger: { info: mock(), warn, error: mock(), debug: mock() },
  }))

  // Only what services/resources.ts (and its transitive line-count.ts) import.
  const uploadFile = mock(() => Promise.resolve())
  // Defaults to "no existing blob" so every test below exercises the
  // normal compress+upload path unless a test overrides this to prove
  // dedup (issue #108 content-addressed blob dedup).
  const headObject = mock(() => Promise.resolve({ exists: false }))
  mock.module('../../../src/config/storage.js', () => ({
    abortMultipartUpload: mock(),
    completeMultipartUpload: mock(),
    createMultipartUpload: mock(),
    deleteFile: mock(),
    getPresignedUrl: mock(),
    listParts: mock(),
    uploadFile,
    uploadPart: mock(),
    downloadFile: mock(),
    headObject,
  }))

  // Field-aware db mock:
  //  - select() (no fields)        -> getResourceById's resource row
  //  - select({keyspace})...limit  -> loadKeyspaceInputs reads the masklist's
  //                                   keyspace back; reflects the persisted write
  //  - select({...}).where (await) -> dependent attacks for the fan-out
  //  - update(maskLists).set({keyspace}) -> the masklist's own keyspace write
  //  - update(attacks).set({keyspace})   -> per-dependent attack keyspace write
  let resourceRow: Record<string, unknown> | null = { id: 1, projectId: 7 }
  let dependents: Array<Record<string, unknown>> = []
  let persistedMasklistKeyspace: string | null = null
  const masklistKeyspaceWrites: Array<string | null> = []
  const attackKeyspaceWrites: Array<number | string | null> = []
  // Captures the resource's own metadata update (fileRef/fileChecksum/
  // blobReclaimedAt/status/etc) — the branch below that is NEITHER a
  // maskLists keyspace write NOR an attacks keyspace write (issue #106 U12).
  let lastResourceUpdateValues: Record<string, unknown> | null = null

  mock.module('../../../src/db/index.js', () => ({
    db: {
      select: (fields?: Record<string, unknown>) => ({
        from: () => ({
          where: () => ({
            limit: () => {
              if (!fields) return Promise.resolve(resourceRow ? [resourceRow] : [])
              if ('keyspace' in fields)
                return Promise.resolve([{ keyspace: persistedMasklistKeyspace }])
              if ('lineCount' in fields) return Promise.resolve([{ lineCount: null }])
              return Promise.resolve([])
            },
            // oxlint-disable-next-line unicorn/no-thenable -- mock satisfies `await` (dependents) and `.limit()`
            then: (resolve: (v: unknown) => unknown) => resolve(dependents),
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          if (table === maskLists && 'keyspace' in values) {
            persistedMasklistKeyspace = values['keyspace'] as string | null
            masklistKeyspaceWrites.push(values['keyspace'] as string | null)
          } else if (table === attacks && 'keyspace' in values) {
            attackKeyspaceWrites.push(values['keyspace'] as number | string | null)
          }
          // Return a thenable so both `.where(...).then(...)` fan-out calls and
          // `.where(...).returning()` (inside the audit transaction) succeed.
          return {
            where: () => ({
              // oxlint-disable-next-line no-thenable -- intentional Drizzle-style thenable query-builder mock
              then: (resolve: (v: unknown) => unknown) => resolve(undefined),
              returning: () => Promise.resolve([resourceRow ?? {}]),
            }),
          }
        },
      }),
      // uploadResourceFile's dedup decision + row commit now run inside
      // `withBlobKeyLock`'s `db.transaction(...)` (#108 T12/T13), so the tx
      // also needs `execute` (the `pg_advisory_xact_lock` call) and `select`
      // (`findCompressionEncodingForKey`'s adopt-encoding lookup on a dedup
      // hit — unused here since every test's `headObject` mock defaults to
      // `{ exists: false }`, but wired for shape-completeness) alongside the
      // same update-tracking logic plus insert for the recorder.
      transaction: async (
        fn: (tx: {
          select: (fields?: Record<string, unknown>) => {
            from: () => { where: () => { limit: () => Promise<unknown[]> } }
          }
          execute: (sql: unknown) => Promise<unknown>
          update: (table: unknown) => {
            set: (values: Record<string, unknown>) => {
              where: (cond: unknown) => { returning: () => Promise<unknown[]> }
            }
          }
          insert: () => { values: () => { returning: () => Promise<{ id: number }[]> } }
        }) => Promise<unknown>
      ) =>
        fn({
          select: () => ({
            from: () => ({
              where: () => ({ limit: () => Promise.resolve([]) }),
            }),
          }),
          execute: async () => ({ rowCount: 0 }),
          update: (table: unknown) => ({
            set: (values: Record<string, unknown>) => {
              if (table === maskLists && 'keyspace' in values) {
                persistedMasklistKeyspace = values['keyspace'] as string | null
                masklistKeyspaceWrites.push(values['keyspace'] as string | null)
              } else if (table === attacks && 'keyspace' in values) {
                attackKeyspaceWrites.push(values['keyspace'] as number | string | null)
              } else {
                lastResourceUpdateValues = values
              }
              return {
                where: () => ({ returning: () => Promise.resolve([resourceRow ?? {}]) }),
              }
            },
          }),
          insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }),
        }),
    },
  }))

  const { uploadResourceFile } = await import('../../../src/services/resources.js')

  function maskFile(content: string): File {
    return new File([content], 'masks.hcmask', { type: 'text/plain' })
  }

  const dependentMaskAttack = {
    id: 10,
    mode: 3,
    wordlistId: null,
    rulelistId: null,
    masklistId: 1,
    advancedConfiguration: {},
  }

  beforeEach(() => {
    resourceRow = { id: 1, projectId: 7 }
    dependents = []
    persistedMasklistKeyspace = null
    masklistKeyspaceWrites.length = 0
    attackKeyspaceWrites.length = 0
    lastResourceUpdateValues = null
    warn.mockClear()
    uploadFile.mockClear()
    headObject.mockClear()
  })

  describe('uploadResourceFile - masklist direct-upload sizing + fan-out (#231)', () => {
    test('computable masklist persists summed keyspace and fans out to a dependent attack', async () => {
      dependents = [dependentMaskAttack]
      // ?l?l = 676, ?d?d?d = 1000 -> 1676
      const result = await uploadResourceFile(
        maskLists,
        1,
        7,
        'masklists',
        maskFile('?l?l\n?d?d?d')
      )

      expect(masklistKeyspaceWrites).toEqual(['1676'])
      expect(attackKeyspaceWrites).toEqual(['1676']) // fan-out fired
      expect(warn).not.toHaveBeenCalled()
      expect(result.size).toBeGreaterThan(0)
    })

    test('uncomputable masklist persists null AND still fans out to clear a stale dependent', async () => {
      dependents = [dependentMaskAttack]
      // `?d?l,abc` is an inline custom-charset definition -> uncomputable.
      const result = await uploadResourceFile(maskLists, 1, 7, 'masklists', maskFile('?d?l,abc'))

      expect(masklistKeyspaceWrites).toEqual([null])
      // The asymmetry fix: a null masklist keyspace MUST propagate to dependents.
      expect(attackKeyspaceWrites).toEqual([null])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(result.size).toBeGreaterThan(0)
    })

    test('wordlist upload does not write a masklist keyspace (control)', async () => {
      // A non-masklist resource is sized by line count; no keyspace column write.
      resourceRow = { id: 2, projectId: 7 }
      await uploadResourceFile(wordLists, 2, 7, 'wordlists', maskFile('alpha\nbravo\ncharlie'))

      expect(masklistKeyspaceWrites).toHaveLength(0)
    })
  })

  describe('uploadResourceFile - reclaimed-shell checksum verification (issue #106 U12)', () => {
    test('a normal (non-shell) upload captures file_checksum and leaves blob_reclaimed_at untouched', async () => {
      resourceRow = { id: 2, projectId: 7, blobReclaimedAt: null, fileChecksum: null }
      const content = 'alpha\nbravo\ncharlie'

      await uploadResourceFile(wordLists, 2, 7, 'wordlists', maskFile(content))

      expect(uploadFile).toHaveBeenCalledTimes(1)
      expect(lastResourceUpdateValues?.['fileChecksum']).toBe(sha256Hex(content))
      // Non-shell upload: blobReclaimedAt is simply omitted from the update
      // (never forced to null — there is nothing to clear).
      expect(lastResourceUpdateValues).not.toHaveProperty('blobReclaimedAt')
    })

    test('a reclaimed-shell re-upload with a matching checksum clears blob_reclaimed_at and uploads', async () => {
      const content = 'alpha\nbravo\ncharlie'
      const originalChecksum = sha256Hex(content)
      resourceRow = {
        id: 2,
        projectId: 7,
        blobReclaimedAt: new Date('2026-01-01T00:00:00Z'),
        fileChecksum: originalChecksum,
      }

      await uploadResourceFile(wordLists, 2, 7, 'wordlists', maskFile(content))

      expect(uploadFile).toHaveBeenCalledTimes(1)
      expect(lastResourceUpdateValues?.['fileChecksum']).toBe(originalChecksum)
      expect(lastResourceUpdateValues?.['blobReclaimedAt']).toBeNull()
    })

    test('a reclaimed-shell re-upload with a mismatched checksum is rejected before any storage write', async () => {
      resourceRow = {
        id: 2,
        projectId: 7,
        blobReclaimedAt: new Date('2026-01-01T00:00:00Z'),
        fileChecksum: sha256Hex('the-original-file-content'),
      }

      await expect(
        uploadResourceFile(wordLists, 2, 7, 'wordlists', maskFile('a-completely-different-file'))
      ).rejects.toThrow(/reclaimed shell/i)

      // The whole point of computing the checksum before the S3 write: a
      // mismatch must never reach storage, and the row must stay untouched.
      expect(uploadFile).not.toHaveBeenCalled()
      expect(lastResourceUpdateValues).toBeNull()
    })
  })

  describe('uploadResourceFile - direct-upload compression (issue #108 U3)', () => {
    test('a compressible file is stored gzip-encoded, and the bytes uploaded gunzip to the exact original', async () => {
      resourceRow = { id: 2, projectId: 7, blobReclaimedAt: null, fileChecksum: null }
      // Long, highly repetitive content compresses well under gzip.
      const content = 'alpha\nbravo\ncharlie\n'.repeat(200)

      await uploadResourceFile(wordLists, 2, 7, 'wordlists', maskFile(content))

      expect(uploadFile).toHaveBeenCalledTimes(1)
      const [, uploadedBytes] = uploadFile.mock.calls[0] as [string, Buffer, string]
      expect(gunzipSync(uploadedBytes).toString('utf8')).toBe(content)

      expect(lastResourceUpdateValues?.['compressionEncoding']).toBe('gzip')
      // fileSize/fileChecksum always describe the RAW file, never the
      // compressed-at-rest bytes.
      expect(lastResourceUpdateValues?.['fileSize']).toBe(Buffer.byteLength(content, 'utf8'))
      expect(lastResourceUpdateValues?.['fileChecksum']).toBe(sha256Hex(content))
    })

    test('a tiny/incompressible file is stored as-is with encoding none', async () => {
      resourceRow = { id: 2, projectId: 7, blobReclaimedAt: null, fileChecksum: null }
      const content = 'a'

      await uploadResourceFile(wordLists, 2, 7, 'wordlists', maskFile(content))

      expect(uploadFile).toHaveBeenCalledTimes(1)
      const [, uploadedBytes] = uploadFile.mock.calls[0] as [string, Buffer, string]
      expect(uploadedBytes.toString('utf8')).toBe(content)

      expect(lastResourceUpdateValues?.['compressionEncoding']).toBe('none')
      expect(lastResourceUpdateValues?.['fileSize']).toBe(Buffer.byteLength(content, 'utf8'))
      expect(lastResourceUpdateValues?.['fileChecksum']).toBe(sha256Hex(content))
    })
  })
}
