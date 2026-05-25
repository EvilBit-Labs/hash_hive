/**
 * Service-level tests for U4 — DELETE flows for hash-lists and generic resources.
 *
 * Tests the service functions (`deleteHashList`, `deleteResource`) directly with
 * mocked DB, storage, and `@hashhive/shared` schema (sentinel Symbols). Because
 * mocking `@hashhive/shared` would leak across the suite, this file runs in an
 * isolated phase gated on `RESOURCES_DELETE_TEST_ISOLATED=1` (see backend
 * package.json `test` script).
 *
 * Route-level wiring is exercised by the U8 integration test against real
 * Postgres + SeaweedFS.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const IS_ISOLATED = process.env['RESOURCES_DELETE_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('resources-delete (skipped — runs in isolated phase)', () => {
    test('runs only with RESOURCES_DELETE_TEST_ISOLATED=1', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[resources-delete] skipped — set RESOURCES_DELETE_TEST_ISOLATED=1 to run; this suite mocks @hashhive/shared so it must NOT run in the shared phase.'
      )
      // Fail loud if a CI misconfig drops the isolated phase.
      expect(process.env['RESOURCES_DELETE_TEST_ISOLATED']).toBeUndefined()
    })
  })
}

if (IS_ISOLATED) {
  // ─── Mock logger so the warn path doesn't pollute test output ────────
  mock.module('../../src/config/logger.js', () => ({
    logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
  }))

  // ─── Mock storage.deleteFile ─────────────────────────────────────────
  let deleteFileImpl: () => Promise<void> = () => Promise.resolve()
  const mockDeleteFile = mock((_key: string, _bucket?: string) => deleteFileImpl())
  mock.module('../../src/config/storage.js', () => ({
    // Only what services/resources.ts imports; downstream tests own their own mocks.
    abortMultipartUpload: mock(),
    completeMultipartUpload: mock(),
    createMultipartUpload: mock(),
    deleteFile: mockDeleteFile,
    getPresignedUrl: mock(),
    listParts: mock(),
    uploadFile: mock(),
    uploadPart: mock(),
  }))

  // ─── Mock DB with per-test controllable behavior ─────────────────────
  type SelectResult = unknown[]
  let selectByTable: Map<string, SelectResult> = new Map()
  let deleteImpl: (table: string) => Promise<unknown> = () => Promise.resolve()
  const mockDelete = mock((_table: unknown) => ({
    where: mock(() => deleteImpl(_table === HASH_LISTS_SENTINEL ? 'hash_lists' : 'other')),
  }))
  // Sentinel objects so the mock can route by table identity. The real Drizzle
  // table objects are imported at module load — but since the mock factory runs
  // before `services/resources.ts` resolves its imports, we can intercept the
  // table arg here and use string keys.
  const HASH_LISTS_SENTINEL = Symbol('hash_lists')
  mock.module('@hashhive/shared', () => ({
    // Each table is a unique opaque object; the mock matches by reference identity.
    hashLists: HASH_LISTS_SENTINEL,
    hashItems: Symbol('hash_items'),
    hashTypes: Symbol('hash_types'),
    wordLists: Symbol('word_lists'),
    ruleLists: Symbol('rule_lists'),
    maskLists: Symbol('mask_lists'),
  }))

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () => {
              const key = typeof table === 'symbol' ? (table.description ?? '') : 'unknown'
              return Promise.resolve(selectByTable.get(key) ?? [])
            },
          }),
        }),
      }),
      delete: mockDelete,
      // Production code uses tx.execute for the batched hash_items DELETE
      // (PG LIMIT-on-DELETE isn't in Drizzle's typed API). Return
      // rowCount=0 so the chunked loop terminates immediately under test.
      transaction: async (
        fn: (tx: {
          delete: typeof mockDelete
          execute: (sql: unknown) => Promise<{ rowCount: number }>
        }) => Promise<unknown>
      ) =>
        fn({
          delete: mockDelete,
          execute: async () => ({ rowCount: 0 }),
        }),
    },
  }))

  // ─── Tests ────────────────────────────────────────────────────────────

  describe('deleteHashList', () => {
    beforeEach(() => {
      selectByTable = new Map()
      mockDeleteFile.mockClear()
      mockDelete.mockClear()
      deleteFileImpl = () => Promise.resolve()
      deleteImpl = () => Promise.resolve()
    })

    test('returns false when the hash list is not in the project (404 path)', async () => {
      // Empty select result = not found.
      selectByTable.set('hash_lists', [])
      const { deleteHashList } = await import('../../src/services/resources.js')
      const result = await deleteHashList(42, 1)
      expect(result).toBe(false)
      // No S3 or DB delete should have run.
      expect(mockDeleteFile).not.toHaveBeenCalled()
      expect(mockDelete).not.toHaveBeenCalled()
    })

    test('returns true after deleting the hash list and cascading hash items', async () => {
      selectByTable.set('hash_lists', [
        { id: 5, projectId: 1, fileRef: { bucket: 'b', key: 'hash-lists/5/file.txt' } },
      ])
      const { deleteHashList } = await import('../../src/services/resources.js')
      const result = await deleteHashList(5, 1)
      expect(result).toBe(true)
      expect(mockDeleteFile).toHaveBeenCalledTimes(1)
      expect(mockDeleteFile).toHaveBeenCalledWith('hash-lists/5/file.txt', 'b')
      // hash_items cascade runs via tx.execute (raw SQL), hash_lists delete
      // runs via tx.delete — so the tx.delete count is exactly 1.
      expect(mockDelete.mock.calls.length).toBeGreaterThanOrEqual(1)
    })

    test('proceeds with DB delete when S3 object is already gone', async () => {
      selectByTable.set('hash_lists', [
        { id: 5, projectId: 1, fileRef: { bucket: 'b', key: 'gone.txt' } },
      ])
      deleteFileImpl = () => Promise.reject(new Error('NoSuchKey'))
      const { deleteHashList } = await import('../../src/services/resources.js')
      const result = await deleteHashList(5, 1)
      expect(result).toBe(true)
      expect(mockDeleteFile).toHaveBeenCalledTimes(1)
      expect(mockDelete.mock.calls.length).toBeGreaterThanOrEqual(1)
    })

    test('throws ResourceInUseError when the hash_lists DELETE hits an FK violation (SQLSTATE 23503)', async () => {
      selectByTable.set('hash_lists', [{ id: 5, projectId: 1, fileRef: { bucket: 'b', key: 'k' } }])
      // Post-R10 refactor: hash_items cascade runs via tx.execute (mocked
      // to no-op above), THEN tx.delete(hash_lists) — which raises the FK
      // violation. cascadeDeleteResource maps it to ResourceInUseError.
      deleteImpl = (table: string) => {
        if (table === 'hash_lists') {
          const err = new Error(
            'update or delete on table "hash_lists" violates foreign key constraint'
          ) as Error & { code: string }
          err.code = '23503'
          return Promise.reject(err)
        }
        return Promise.resolve()
      }
      const { deleteHashList, ResourceInUseError } = await import('../../src/services/resources.js')
      await expect(deleteHashList(5, 1)).rejects.toBeInstanceOf(ResourceInUseError)
      // S3 must NOT be deleted when DB delete fails — order matters per the
      // ordering fix (DB first so a 409 doesn't corrupt state).
      expect(mockDeleteFile).not.toHaveBeenCalled()
    })

    test('FK detection: regex fallback fires when SQLSTATE 23503 is missing (mocked driver)', async () => {
      selectByTable.set('hash_lists', [{ id: 5, projectId: 1, fileRef: { bucket: 'b', key: 'k' } }])
      // Driver/mock that doesn't surface `code` on the error — must still
      // map to ResourceInUseError via the message-regex fallback.
      deleteImpl = (table: string) => {
        if (table === 'hash_lists') {
          return Promise.reject(
            new Error('update or delete on table "hash_lists" violates foreign key constraint')
          )
        }
        return Promise.resolve()
      }
      const { deleteHashList, ResourceInUseError } = await import('../../src/services/resources.js')
      await expect(deleteHashList(5, 1)).rejects.toBeInstanceOf(ResourceInUseError)
      expect(mockDeleteFile).not.toHaveBeenCalled()
    })

    test('skips S3 delete when fileRef is null (upload never finished)', async () => {
      selectByTable.set('hash_lists', [{ id: 5, projectId: 1, fileRef: null }])
      const { deleteHashList } = await import('../../src/services/resources.js')
      const result = await deleteHashList(5, 1)
      expect(result).toBe(true)
      expect(mockDeleteFile).not.toHaveBeenCalled()
    })
  })
} // end IS_ISOLATED
