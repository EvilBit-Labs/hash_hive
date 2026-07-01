/**
 * Unit tests for runHashImportJob — the extracted worker body (issue #102).
 *
 * Tests the download → parse → process → delete pipeline without a live Redis
 * or S3 connection. Storage is mocked; `processImportPairs` runs against fake
 * Drizzle chains so no DB connection is needed.
 *
 * Test scenarios:
 *   4a. Success path: valid JSON body → processImportPairs runs → deleteFile called.
 *   4b. Corrupt JSON: deleteFile called before UnrecoverableError is thrown (no retries).
 *
 * Must run with HASH_IMPORT_JOB_TEST_ISOLATED=1.
 */

import { UnrecoverableError } from 'bullmq'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['HASH_IMPORT_JOB_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('hash-import-job (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn('[hash-import-job] skipped — set HASH_IMPORT_JOB_TEST_ISOLATED=1 to run.')
      expect(process.env['HASH_IMPORT_JOB_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── Storage mocks ────────────────────────────────────────────────────────────

  const mockDownloadFile = mock(async (..._args: unknown[]) => ({
    Body: { transformToString: async () => '[]' },
  }))
  const mockDeleteFile = mock(async (..._args: unknown[]) => {})

  // ─── Module mocks — must precede any worker import ────────────────────────────

  mock.module('../../../src/config/logger.js', () => ({
    logger: {
      info: mock(),
      warn: mock(),
      error: mock(),
      debug: mock(),
    },
  }))

  mock.module('../../../src/config/storage.js', () => ({
    downloadFile: mockDownloadFile,
    deleteFile: mockDeleteFile,
  }))

  // Fake Drizzle chains so processImportPairs can run without a live DB.
  // upsertTargetListBatches needs:
  //   - db.select({matched,willCrack}).from(...).where(...)  → [{matched:0,willCrack:0}]
  //   - db.insert(...).values(...).onConflictDoUpdate(...)   → []
  // propagateImportedCracks needs:
  //   - db.selectDistinct({hashValue}).from(...).where(...)  → []
  mock.module('../../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ matched: 0, willCrack: 0 }]),
        }),
      }),
      selectDistinct: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => Promise.resolve([]),
        }),
      }),
    },
    client: new Proxy(
      {},
      {
        get(_t, p) {
          throw new Error(`Test mock: unexpected access to client.${String(p)}`)
        },
      }
    ),
  }))

  mock.module('../../../src/services/audit-log.js', () => ({
    recordAuditEvent: mock(async () => {}),
  }))

  mock.module('../../../src/services/hash-items/propagation.js', () => ({
    propagateCrack: mock(async () => ({ updated: 0 })),
  }))

  // ─── Import under test (after all mocks) ──────────────────────────────────────

  const { runHashImportJob } = await import('../../../src/queue/workers/hash-import-worker.js')

  // ─── Fixtures ────────────────────────────────────────────────────────────────

  const STAGING_KEY = 'test-project/import-staging/test-uuid.json'
  const SYSTEM_ACTOR = { actorType: 'system' as const, actorId: null }

  const makeJobData = () => ({
    stagingKey: STAGING_KEY,
    hashListId: 1,
    projectId: 1,
    actor: SYSTEM_ACTOR,
    skippedFromParse: 0,
  })

  beforeEach(() => {
    mockDownloadFile.mockReset()
    mockDownloadFile.mockImplementation(async () => ({
      Body: { transformToString: async () => '[]' },
    }))
    mockDeleteFile.mockReset()
    mockDeleteFile.mockImplementation(async () => {})
  })

  // ─── Tests ───────────────────────────────────────────────────────────────────

  describe('runHashImportJob — success path (4a)', () => {
    it('downloads staged file, processes pairs, and deletes staging file on success', async () => {
      const pairs = [{ hashValue: 'deadbeef', plaintext: 'pass' }]
      mockDownloadFile.mockImplementation(async () => ({
        Body: { transformToString: async () => JSON.stringify(pairs) },
      }))

      const result = await runHashImportJob(makeJobData(), 'job-4a')

      // Returns a valid ImportSummary
      expect(result).toMatchObject({ matchedInList: 0, crackedInList: 0, skipped: 0 })

      // Download ran with the staging key
      expect(mockDownloadFile).toHaveBeenCalledWith(STAGING_KEY)

      // Staging file deleted after successful processing
      expect(mockDeleteFile).toHaveBeenCalledWith(STAGING_KEY)
    })
  })

  describe('runHashImportJob — corrupt JSON (4b)', () => {
    it('deletes staging file before throwing UnrecoverableError so no retries consume a bad file', async () => {
      mockDownloadFile.mockImplementation(async () => ({
        Body: { transformToString: async () => 'not-valid-json{{{' },
      }))

      await expect(runHashImportJob(makeJobData(), 'job-4b')).rejects.toBeInstanceOf(
        UnrecoverableError
      )

      // Cleanup must run before the throw so the orphaned staging file is removed
      expect(mockDeleteFile).toHaveBeenCalledWith(STAGING_KEY)
    })
  })
}
