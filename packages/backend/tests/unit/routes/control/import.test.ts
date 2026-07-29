/**
 * Control API pre-cracked import route tests (issue #102, unit U8).
 *
 * Verifies POST /api/v1/control/import/hash-lists/{id}:
 *   - 202 on happy path: ownership check, parse, stage, enqueue, summary shape
 *   - 404 when hash list not found (KTD9: ownership before parse/enqueue)
 *   - 403 when caller role is insufficient
 *   - 400 when request body fails schema validation
 *   - 503 when object-store upload fails
 *   - 503 when queue manager is unavailable
 *   - 503 when enqueue returns false
 *   - Negative-shape contract test (KTD7): response has no cross-project field
 *
 * Isolation: mocks routes/control/helpers.js, services/resources.js,
 * services/hash-items/import-parse.js, config/storage.js, queue/context.js,
 * queue/workers/hash-import-worker.js, db/index.js, ioredis.
 * Must run with CONTROL_HASH_IMPORT_TEST_ISOLATED=1.
 *
 * KTD8: mock fixtures typed against service ReturnType so the test pins the
 * service contract, not the route response schema.
 */

import { importSummarySchema } from '@hashhive/shared'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['CONTROL_HASH_IMPORT_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('control-hash-import (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[control-hash-import] skipped - set CONTROL_HASH_IMPORT_TEST_ISOLATED=1 to run.'
      )
      expect(process.env['CONTROL_HASH_IMPORT_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── KTD8 fixtures typed against service ReturnTypes ─────────────────────────

  type HashList = Awaited<
    ReturnType<typeof import('../../../../src/services/resources.js').getHashListById>
  >

  type ParseResult = Awaited<
    ReturnType<
      typeof import('../../../../src/services/hash-items/import-parse.js').parseImportContent
    >
  >

  const makeHashList = (
    overrides: Partial<Exclude<HashList, null>> = {}
  ): Exclude<HashList, null> =>
    ({
      id: 42,
      projectId: 1,
      name: 'test-list',
      hashTypeId: 1,
      source: 'upload',
      status: 'ready',
      fileRef: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as Exclude<HashList, null>

  const makeParseResult = (overrides: Partial<ParseResult> = {}): ParseResult =>
    ({
      pairs: [{ hashValue: 'abc123', plaintext: 'password' }],
      skipped: 0,
      ...overrides,
    }) satisfies ParseResult

  // ─── Controllable state ──────────────────────────────────────────────────────

  let activeProjectId = 1
  let activeMembershipRoles: string[] = ['admin']
  let activeHashList: Exclude<HashList, null> | null = makeHashList()
  let activeParseResult: ParseResult = makeParseResult()
  let mockUploadShouldFail = false
  let mockEnqueueResult = true
  let mockQueueManagerNull = false

  const mockUploadFile = mock(async (..._args: unknown[]) => {
    if (mockUploadShouldFail) throw new Error('S3 error')
  })
  const mockDeleteFile = mock(async (..._args: unknown[]) => {})
  const mockParseImportContent = mock((..._args: unknown[]) => activeParseResult)
  const mockGetHashListById = mock(async (..._args: unknown[]) => activeHashList)
  const mockGetHashTypeById = mock(async (..._args: unknown[]) => ({
    id: 1,
    name: 'MD5',
    hashcatMode: 0,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }))
  const mockEnqueue = mock(async (..._args: unknown[]) => mockEnqueueResult)

  // ─── Module mocks — must precede any route import ────────────────────────────

  mock.module('../../../../src/db/index.js', () => ({
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
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

  mock.module('ioredis', () => ({
    default: class MockRedis {
      ping() {
        return Promise.resolve('PONG')
      }
      on() {
        return this
      }
      disconnect() {}
    },
  }))

  mock.module('../../../../src/routes/control/helpers.js', () => ({
    requireProjectRole: async () => {
      if (
        !activeMembershipRoles.includes('admin') &&
        !activeMembershipRoles.includes('contributor')
      ) {
        const err = Object.assign(new Error('Forbidden'), { status: 403 })
        throw err
      }
      return { projectId: activeProjectId, roles: activeMembershipRoles }
    },
    controlErrorResponse: (
      c: { json: (body: unknown, status: number) => Response },
      err: unknown
    ) => {
      const message = err instanceof Error ? err.message : 'unknown'
      const status =
        err instanceof Error && 'status' in err
          ? ((err as Error & { status?: number }).status ?? 500)
          : 500
      const code = status === 403 ? 'forbidden' : status === 400 ? 'validation' : 'internal'
      return c.json(
        {
          type: `https://hashhive.dev/errors/${code}`,
          title:
            status === 403 ? 'Forbidden' : status === 400 ? 'Validation failed' : 'Internal error',
          status,
          detail: message,
          instance: '/',
        },
        status
      )
    },
  }))

  mock.module('../../../../src/services/resources.js', () => ({
    getHashListById: mockGetHashListById,
    getHashTypeById: mockGetHashTypeById,
    // `mock.module` is process-global and leaks across files in a shared bun
    // run. Other suites' routers (e.g. the search route via `hashes.ts`) link
    // `escapeLike` from resources.ts, so this mock must re-export it too or that
    // linkage fails when this mock is the active one — mirrors the same
    // re-export in `dashboard/import-precracked.test.ts`.
    escapeLike: (value: string) => value,
  }))

  mock.module('../../../../src/services/hash-items/import-parse.js', () => ({
    parseImportContent: mockParseImportContent,
  }))

  mock.module('../../../../src/config/storage.js', () => ({
    uploadFile: mockUploadFile,
    deleteFile: mockDeleteFile,
  }))

  mock.module('../../../../src/queue/context.js', () => ({
    getQueueManager: () => {
      if (mockQueueManagerNull) return null
      return { enqueue: mockEnqueue }
    },
  }))

  mock.module('../../../../src/queue/workers/hash-import-worker.js', () => ({
    buildHashImportJobId: (hashListId: number, stagingKey: string) =>
      `hash-import:${hashListId}:${stagingKey}`,
  }))

  // ─── Route mount (after all mocks) ───────────────────────────────────────────

  const { controlImportRoutes } = await import('../../../../src/routes/control/import.js')
  const { Hono } = await import('hono')
  // Cast includes `use` so we can inject a fake currentUser middleware that
  // mirrors what requireApiKey normally sets (control surface skips requireApiKey
  // when the route is mounted directly in tests).
  const app = new (Hono as { new (): { use: Function; route: Function; request: Function } })()
  app.use('*', async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('currentUser', {
      userId: 1,
      email: 'api@test.local',
      roles: [],
      projectId: activeProjectId,
    })
    await next()
  })
  app.route('/', controlImportRoutes)

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function makeRequest(id: number, body: unknown, headers: Record<string, string> = {}) {
    return (
      app as unknown as { request: (url: string, init: RequestInit) => Promise<Response> }
    ).request(`/hash-lists/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  beforeEach(() => {
    activeProjectId = 1
    activeMembershipRoles = ['admin']
    activeHashList = makeHashList()
    activeParseResult = makeParseResult()
    mockUploadShouldFail = false
    mockEnqueueResult = true
    mockQueueManagerNull = false
    mockUploadFile.mockReset()
    mockUploadFile.mockImplementation(async (..._args: unknown[]) => {
      if (mockUploadShouldFail) throw new Error('S3 error')
    })
    mockDeleteFile.mockReset()
    mockDeleteFile.mockImplementation(async () => {})
    mockParseImportContent.mockReset()
    mockParseImportContent.mockImplementation(() => activeParseResult)
    mockGetHashListById.mockReset()
    mockGetHashListById.mockImplementation(async () => activeHashList)
    mockGetHashTypeById.mockReset()
    mockGetHashTypeById.mockImplementation(async () => ({
      id: 1,
      name: 'MD5',
      hashcatMode: 0,
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
    mockEnqueue.mockReset()
    mockEnqueue.mockImplementation(async () => mockEnqueueResult)
  })

  // ─── Tests ───────────────────────────────────────────────────────────────────

  describe('POST /hash-lists/{id} (control import)', () => {
    it('202 happy path: parses content, stages pairs, enqueues job, returns summary', async () => {
      activeParseResult = makeParseResult({
        pairs: [{ hashValue: 'abc', plaintext: 'pass' }],
        skipped: 3,
      })

      const res = await makeRequest(42, { content: 'abc:pass', format: 'pairs' })
      expect(res.status).toBe(202)

      const body = await res.json()

      // KTD7 negative-shape: strict schema must accept body and no cross-project field present
      const parsed = importSummarySchema.safeParse(body)
      expect(parsed.success).toBe(true)
      expect(Object.keys(body).sort()).toStrictEqual(['crackedInList', 'matchedInList', 'skipped'])
      expect('matchedAcrossProjects' in body).toBe(false)

      // Compartmentalized counts at enqueue time
      expect(body.matchedInList).toBe(0)
      expect(body.crackedInList).toBe(0)
      expect(body.skipped).toBe(3)

      // Ownership check ran
      expect(mockGetHashListById).toHaveBeenCalledWith(42, 1)

      // Staging upload ran with JSON array (KTD3: pairs only, not full result)
      expect(mockUploadFile).toHaveBeenCalledTimes(1)
      const [stagingKey, stagingBody, contentType] = mockUploadFile.mock.calls[0] as [
        string,
        Buffer,
        string,
      ]
      expect(stagingKey).toMatch(/^1\/import-staging\/.+\.json$/)
      expect(contentType).toBe('application/json')
      const staged = JSON.parse(stagingBody.toString())
      expect(Array.isArray(staged)).toBe(true)

      // Enqueue ran with correct payload shape
      expect(mockEnqueue).toHaveBeenCalledTimes(1)
      const [queueName, payload, opts] = mockEnqueue.mock.calls[0] as [
        string,
        Record<string, unknown>,
        Record<string, unknown>,
      ]
      expect(queueName).toBe('jobs-hash-import-propagation')
      expect(payload.hashListId).toBe(42)
      expect(payload.projectId).toBe(1)
      expect(payload.skippedFromParse).toBe(3)
      // RF1: the resolved mode must ride in the job so the worker can populate
      // the cracked-set and mode-scope propagation (default hash type → mode 0).
      expect(payload.hashcatMode).toBe(0)
      expect(typeof payload.stagingKey).toBe('string')
      expect('actor' in payload).toBe(true)
      expect(typeof opts.jobId).toBe('string')
    })

    it('404 when hash list not found (ownership check before parse/stage/enqueue)', async () => {
      activeHashList = null

      const res = await makeRequest(99, { content: 'abc:pass', format: 'pairs' })
      expect(res.status).toBe(404)

      // Must not proceed to parse/upload/enqueue after ownership failure
      expect(mockParseImportContent).not.toHaveBeenCalled()
      expect(mockUploadFile).not.toHaveBeenCalled()
      expect(mockEnqueue).not.toHaveBeenCalled()
    })

    it('403 when caller has viewer role only', async () => {
      activeMembershipRoles = ['viewer']

      const res = await makeRequest(42, { content: 'abc:pass', format: 'pairs' })
      expect(res.status).toBe(403)
    })

    it('400 when format is invalid', async () => {
      const res = await makeRequest(42, { content: 'abc:pass', format: 'bad-format' })
      expect(res.status).toBe(400)
    })

    it('400 when content is empty', async () => {
      const res = await makeRequest(42, { content: '', format: 'pairs' })
      expect(res.status).toBe(400)
    })

    it('503 when object-store upload fails', async () => {
      mockUploadShouldFail = true

      const res = await makeRequest(42, { content: 'abc:pass', format: 'pairs' })
      expect(res.status).toBe(503)

      // Enqueue must not run after staging failure
      expect(mockEnqueue).not.toHaveBeenCalled()
    })

    it('503 when queue manager is unavailable (null)', async () => {
      mockQueueManagerNull = true

      const res = await makeRequest(42, { content: 'abc:pass', format: 'pairs' })
      expect(res.status).toBe(503)
    })

    it('503 when enqueue returns false, triggers best-effort staging cleanup', async () => {
      mockEnqueueResult = false

      const res = await makeRequest(42, { content: 'abc:pass', format: 'pairs' })
      expect(res.status).toBe(503)

      // Cleanup should be attempted for the orphaned staging file
      expect(mockDeleteFile).toHaveBeenCalledTimes(1)
    })

    // ─── (new) test 11: hashcatMode threading ──────────────────────────────────

    it('passes resolved hashcatMode to parseImportContent when hash list has a hashTypeId (11a)', async () => {
      // Default state: activeHashList.hashTypeId = 1, mockGetHashTypeById returns hashcatMode = 0
      const res = await makeRequest(42, { content: 'abc:pass', format: 'pairs' })
      expect(res.status).toBe(202)

      // getHashTypeById must have been called with the list's hashTypeId
      expect(mockGetHashTypeById).toHaveBeenCalledWith(1)
      // parseImportContent's third arg must be the resolved hashcatMode (0)
      const [, , resolvedMode] = mockParseImportContent.mock.calls[0] as [
        string,
        string,
        number | null,
      ]
      expect(resolvedMode).toBe(0)
    })

    it('passes null hashcatMode to parseImportContent when hash list has no hashTypeId (11b)', async () => {
      activeHashList = makeHashList({ hashTypeId: null })

      const res = await makeRequest(42, { content: 'abc:pass', format: 'pairs' })
      expect(res.status).toBe(202)

      // getHashTypeById must NOT be called when hashTypeId is null
      expect(mockGetHashTypeById).not.toHaveBeenCalled()
      // parseImportContent's third arg must be null
      const [, , resolvedMode] = mockParseImportContent.mock.calls[0] as [
        string,
        string,
        number | null,
      ]
      expect(resolvedMode).toBeNull()
    })

    // ─── (new) test 12: unexpected throw after staging triggers cleanup ─────────

    it('500 problem+json when enqueue throws unexpectedly after staging — staging file is cleaned up (12)', async () => {
      mockEnqueue.mockImplementation(async () => {
        throw new Error('Unexpected queue error')
      })

      const res = await makeRequest(42, { content: 'abc:pass', format: 'pairs' })
      expect(res.status).toBe(500)

      // Staging upload ran before the throw
      expect(mockUploadFile).toHaveBeenCalledTimes(1)
      // Best-effort cleanup was attempted for the orphaned staging file
      expect(mockDeleteFile).toHaveBeenCalledTimes(1)

      // Control surface wraps errors in RFC 9457 problem+json
      const body = await res.json()
      expect(body).toMatchObject({ status: 500, type: expect.stringContaining('internal') })
    })
  })
}
