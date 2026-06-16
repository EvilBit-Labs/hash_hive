/**
 * Service-level tests for the direct-upload masklist sizing + keyspace fan-out
 * in `uploadResourceFile` (issue #231).
 *
 * The route-level suite fully mocks `uploadResourceFile`, so the real sizing and
 * the fan-out *decision* are only exercised here. The discriminating case is an
 * UNCOMPUTABLE masklist: its keyspace persists as null AND the fan-out still
 * fires (a dependent attack is rewritten to null) — proving the direct-upload
 * path propagates null instead of leaving dependents on a stale value.
 *
 * Mocks only the lowest boundaries (logger, storage, db); `keyspace.js` and
 * `attacks/complexity.js` run for real so the count -> persist -> fan-out wiring
 * is genuinely exercised. Because the db mock would leak process-wide, this file
 * runs in an isolated phase gated on `RESOURCES_UPLOAD_TEST_ISOLATED=1` (see
 * backend package.json `test` script).
 */
import { attacks, maskLists, wordLists } from '@hashhive/shared'
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const IS_ISOLATED = process.env['RESOURCES_UPLOAD_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('resources-upload (skipped — runs in isolated phase)', () => {
    test('runs only with RESOURCES_UPLOAD_TEST_ISOLATED=1', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[resources-upload] skipped — set RESOURCES_UPLOAD_TEST_ISOLATED=1 to run; this suite mocks db so it must NOT run in the shared phase.'
      )
      // Fail loud if a CI misconfig drops the isolated phase.
      expect(process.env['RESOURCES_UPLOAD_TEST_ISOLATED']).toBeUndefined()
    })
  })
}

if (IS_ISOLATED) {
  const warn = mock()
  mock.module('../../../src/config/logger.js', () => ({
    logger: { info: mock(), warn, error: mock(), debug: mock() },
  }))

  // Only what services/resources.ts (and its transitive line-count.ts) import.
  mock.module('../../../src/config/storage.js', () => ({
    abortMultipartUpload: mock(),
    completeMultipartUpload: mock(),
    createMultipartUpload: mock(),
    deleteFile: mock(),
    getPresignedUrl: mock(),
    listParts: mock(),
    uploadFile: mock(() => Promise.resolve()),
    uploadPart: mock(),
    downloadFile: mock(),
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
          return { where: () => Promise.resolve() }
        },
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
    warn.mockClear()
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
}
