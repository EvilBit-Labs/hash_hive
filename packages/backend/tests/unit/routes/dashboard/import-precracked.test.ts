/**
 * Dashboard hash import route tests (issue #102, unit U8).
 *
 * Verifies POST /api/v1/dashboard/hashes/hash-lists/{id}/import-precracked:
 *   - 202 on happy path: ownership check, parse, stage, enqueue, summary shape
 *   - 404 when hash list not found (KTD9: ownership before parse/enqueue)
 *   - 403 when caller role is insufficient
 *   - 400 when request body fails schema validation
 *   - 503 when object-store upload fails
 *   - 503 when queue manager is unavailable
 *   - 503 when enqueue returns false
 *   - Negative-shape contract test (KTD7): response has no cross-project field
 *
 * Isolation: mocks lib/auth.js, services/auth.js, services/resources.js,
 * services/hash-items/import-parse.js, config/storage.js, queue/context.js,
 * queue/workers/hash-import-worker.js, db/index.js, ioredis.
 * Must run with DASHBOARD_HASH_IMPORT_TEST_ISOLATED=1.
 *
 * KTD8: mock fixtures typed against service ReturnType so the test pins the
 * service contract, not the route response schema.
 */

import { importSummarySchema } from '@hashhive/shared'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['DASHBOARD_HASH_IMPORT_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('dashboard-hash-import (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-hash-import] skipped - set DASHBOARD_HASH_IMPORT_TEST_ISOLATED=1 to run.'
      )
      expect(process.env['DASHBOARD_HASH_IMPORT_TEST_ISOLATED']).toBeUndefined()
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

  let activeProjectId: number | null = 1
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

  // ─── Module mocks — must precede any app import ──────────────────────────────

  mock.module('../../../../src/lib/auth.js', () => ({
    auth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const cookie = headers.get('cookie') ?? ''
          if (!cookie.includes('hh.session_token=valid-session')) return null
          return {
            user: { id: '1', email: 'admin@test.local', role: 'admin', banned: null },
            session: {
              userId: '1',
              token: 'tok',
              expiresAt: new Date(Date.now() + 3_600_000),
              projectId: activeProjectId,
            },
          }
        },
      },
      handler: async () => new Response('ok'),
    },
  }))

  mock.module('../../../../src/services/auth.js', () => ({
    getUserWithProjects: async (userId: number) => {
      if (userId === 1) return { id: 1, projects: [{ projectId: 1, roles: ['admin'] }] }
      return null
    },
    findProjectMembership: async (userId: number, projectId: number) => {
      if (activeProjectId === null || projectId !== activeProjectId) return null
      if (userId !== 1) return null
      return { projectId, roles: activeMembershipRoles }
    },
    getUserLastProjectId: async () => null,
    setUserLastProjectIdIfMember: async () => 1,
    setUserLastProjectId: async () => undefined,
    issueUserApiKey: mock(async () => ({ apiKey: 'cst_test', metadata: null })),
    revokeUserApiKey: mock(async () => undefined),
    getUserApiKeyMetadata: mock(async () => null),
  }))

  mock.module('../../../../src/services/resources.js', () => ({
    getHashListById: mockGetHashListById,
    getHashTypeById: mockGetHashTypeById,
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

  // ─── App mount (after all mocks) ─────────────────────────────────────────────

  const { hashRoutes } = await import('../../../../src/routes/dashboard/hashes.js')
  const { Hono } = await import('hono')
  const app = new (Hono as { new (): { route: Function; request: Function } })()
  app.route('/', hashRoutes)

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function makeRequest(id: number, body: unknown, opts: { cookie?: string } = {}) {
    return (
      app as unknown as { request: (url: string, init: RequestInit) => Promise<Response> }
    ).request(`/hash-lists/${id}/import-precracked`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: opts.cookie ?? 'hh.session_token=valid-session',
      },
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

  describe('POST /hash-lists/{id}/import-precracked (dashboard)', () => {
    it('202 happy path: parses content, stages pairs, enqueues job, returns summary', async () => {
      activeParseResult = makeParseResult({
        pairs: [{ hashValue: 'abc', plaintext: 'pass' }],
        skipped: 2,
      })

      const res = await makeRequest(42, { content: 'abc:pass', format: 'pairs' })
      expect(res.status).toBe(202)

      const body = await res.json()

      // KTD7 negative-shape: strict schema must accept body and no cross-project field present
      const parsed = importSummarySchema.safeParse(body)
      expect(parsed.success).toBe(true)
      expect(Object.keys(body).sort()).toStrictEqual(['crackedInList', 'matchedInList', 'skipped'])
      expect('matchedAcrossProjects' in body).toBe(false)

      // Compartmentalized counts: matched/cracked are 0 at enqueue time
      expect(body.matchedInList).toBe(0)
      expect(body.crackedInList).toBe(0)
      expect(body.skipped).toBe(2)

      // Verify ownership check ran
      expect(mockGetHashListById).toHaveBeenCalledWith(42, 1)

      // Verify parse ran
      expect(mockParseImportContent).toHaveBeenCalledTimes(1)

      // Verify staging upload ran with JSON array (not the full result object)
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
      expect(staged[0]).toMatchObject({ hashValue: 'abc', plaintext: 'pass' })

      // Verify enqueue ran with correct payload shape
      expect(mockEnqueue).toHaveBeenCalledTimes(1)
      const [queueName, payload, opts] = mockEnqueue.mock.calls[0] as [
        string,
        Record<string, unknown>,
        Record<string, unknown>,
      ]
      expect(queueName).toBe('jobs-hash-import-propagation')
      expect(payload.hashListId).toBe(42)
      expect(payload.projectId).toBe(1)
      expect(payload.skippedFromParse).toBe(2)
      expect(typeof payload.stagingKey).toBe('string')
      expect('actor' in payload).toBe(true)
      expect(typeof opts.jobId).toBe('string')
    })

    it('404 when hash list is not found (ownership check before parse/stage/enqueue)', async () => {
      activeHashList = null

      const res = await makeRequest(99, { content: 'abc:pass', format: 'pairs' })
      expect(res.status).toBe(404)

      // Ownership check failed — parse and upload must NOT have run
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
      const res = await makeRequest(42, { content: 'abc:pass', format: 'invalid-format' })
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

      // Enqueue must NOT run after staging failure
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

    it('401 when session cookie is missing or invalid', async () => {
      const res = await makeRequest(
        42,
        { content: 'abc:pass', format: 'pairs' },
        {
          cookie: 'hh.session_token=bad-token',
        }
      )
      expect(res.status).toBe(401)
    })
  })
}
