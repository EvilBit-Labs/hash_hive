/**
 * Route-level contract tests for U5 - content-type-aware
 * `POST /api/v1/dashboard/resources/hash-lists`. Covers both branches of
 * the dispatcher (multipart one-shot upload, legacy JSON create-empty)
 * because `tests/integration/hash-list-pipeline.test.ts` bypasses the
 * route and invokes the parser worker directly.
 *
 * Runs in an isolated test phase via the `RESOURCES_ROUTES_TEST_ISOLATED`
 * env gate because this file mocks `services/resources.js` wholesale -
 * the mock leaks process-wide and would clobber the un-mocked imports
 * `resources-delete.test.ts` and `hash-list-pipeline.test.ts` rely on.
 * Mirrors the dashboard-campaigns-routes isolation pattern.
 */
import { describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['RESOURCES_ROUTES_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('dashboard-resources-routes (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-resources-routes] skipped - set RESOURCES_ROUTES_TEST_ISOLATED=1 to run; the route suite did NOT execute in this phase.'
      )
      expect(process.env['RESOURCES_ROUTES_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── Mock BetterAuth + project membership ───────────────────────────

  const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'

  mock.module('../../src/lib/auth.js', () => ({
    auth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const cookie = headers.get('cookie') ?? ''
          if (cookie.includes('valid-admin-session')) {
            return {
              user: {
                id: '1',
                email: 'admin@test.local',
                name: 'Admin',
                emailVerified: true,
                image: null,
                roles: ['admin'],
              },
              session: {
                id: 'sess',
                userId: '1',
                token: 'tok',
                expiresAt: new Date(Date.now() + 3600000),
                // Server-managed scope (issue #159 U4).
                projectId: 1,
              },
            }
          }
          return null
        },
      },
      handler: async () => new Response('ok'),
    },
  }))

  mock.module('../../src/services/auth.js', () => ({
    getUserWithProjects: async (userId: number) => {
      if (userId === 1) {
        return { id: 1, projects: [{ projectId: 1, roles: ['admin'] }] }
      }
      return null
    },
    findProjectMembership: async (userId: number, projectId: number) => {
      if (projectId !== 1) return null
      if (userId === 1) return { projectId: 1, roles: ['admin'] }
      return null
    },
    // Issue #159 U3 / U6: preference helpers must resolve at module
    // import time even if no test exercises them.
    getUserLastProjectId: async () => null,
    setUserLastProjectIdIfMember: async () => 1,
    setUserLastProjectId: async () => undefined,
    issueUserApiKey: mock(async () => ({ apiKey: 'cst_test', metadata: null })),
    revokeUserApiKey: mock(async () => undefined),
    getUserApiKeyMetadata: mock(async () => null),
  }))

  // ─── Mock the Resources Service Layer ───────────────────────────────

  type HashListRow = {
    id: number
    projectId: number
    name: string
    hashTypeId: number | null
    status: string
    fileRef: Record<string, unknown> | null
    statistics: Record<string, unknown> | null
    createdAt: Date
    updatedAt: Date
  }

  const makeHashList = (overrides: Partial<HashListRow> = {}): HashListRow => ({
    id: 42,
    projectId: 1,
    name: 'test-list',
    hashTypeId: null,
    status: 'processing',
    fileRef: { bucket: 'hashhive', key: '1/hash-lists/42-test.txt' },
    statistics: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  })

  // Default behaviors - overridden per-test via mockResolvedValueOnce / mockReset.
  const mockCreateHashList = mock(async (data: { projectId: number; name: string }) =>
    makeHashList({ name: data.name, projectId: data.projectId })
  )
  const mockUploadHashListFile = mock(async () => ({ key: 'some/key', size: 123 }))
  const mockImportHashList = mock(async () => ({ status: 'processing' as const, queued: true }))
  const mockDeleteHashList = mock(async () => ({ kind: 'deleted' as const }))
  const mockGetHashListById = mock(async (id: number) => makeHashList({ id, status: 'processing' }))
  // PATCH /hash-lists/{id} set-hash-type mock. Default: row not in
  // project (null) → route maps to 404. Tests override per-case via
  // mockSetHashListType.mockImplementationOnce(...).
  const mockSetHashListType = mock(
    async (_id: number, _projectId: number, _hashTypeId: number) => null as HashListRow | null
  )

  // Chunked-upload mocks - extracted so route-level tests can override
  // per-case (e.g., to throw UploadResourceNotFoundError and assert the
  // handler's 404 mapping). Return shapes mirror the production service
  // signatures (`uploadChunkPart → { etag }`, `completeChunkedUpload →
  // { resourceId }`) so mock drift doesn't silently mask a real wire
  // contract change.
  const mockUploadChunkPart = mock(async () => ({ etag: 'e' }))
  const mockCompleteChunkedUpload = mock(async () => ({ resourceId: 1 }))

  // Surfaces used by the broader service surface - kept inert so the
  // route module's static imports resolve without exploding.
  const noop = mock(async () => undefined)
  const inertList = mock(async () => [])

  // Recreate the production error class shape so the route's
  // `err instanceof UploadTooLargeError` branch matches.
  class UploadTooLargeErrorMock extends Error {
    size: number
    limit: number
    constructor(size: number, limit: number) {
      super(`Upload too large: ${size} > ${limit}`)
      this.name = 'UploadTooLargeError'
      this.size = size
      this.limit = limit
    }
  }

  class ResourceInUseErrorMock extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ResourceInUseError'
    }
  }

  // The route handler uses `err instanceof UploadResourceNotFoundError`
  // against the value imported from `../../src/services/resources.js`.
  // Bun's `mock.module(...)` below rewrites that import to point at this
  // mock class, so both sides end up referencing the SAME class identity
  // at runtime and `instanceof` matches. The check would silently fail -
  // and the handler would re-map the error to a generic 500 - if any
  // caller imported the real `UploadResourceNotFoundError` from a path
  // the mock doesn't replace. Keep the mock module mapping below and
  // this class shape in lockstep with the production class in
  // `packages/backend/src/services/resources.ts`.
  class UploadResourceNotFoundErrorMock extends Error {
    resourceId: number
    resourceType: string
    constructor(resourceId: number, resourceType: string) {
      super(`Resource ${resourceId} (${resourceType}) not found or not in project scope`)
      this.name = 'UploadResourceNotFoundError'
      this.resourceId = resourceId
      this.resourceType = resourceType
    }
  }

  mock.module('../../src/services/resources.js', () => ({
    // Hash list flow
    createHashList: mockCreateHashList,
    uploadHashListFile: mockUploadHashListFile,
    importHashList: mockImportHashList,
    deleteHashList: mockDeleteHashList,
    getHashListById: mockGetHashListById,
    // PATCH /hash-lists/{id} set-hash-type (issue #163). Wires the
    // outer-scope `mockSetHashListType` declared above so per-test
    // mockImplementationOnce overrides reach the route. Default
    // returns null → 404. Pinned via the mirror-service-not-schema
    // convention's dynamic-factory pattern.
    setHashListType: mockSetHashListType,
    isForeignKeyViolation: (err: unknown, expectedConstraint?: string): boolean => {
      // Mirror the real helper's behavior so route-level tests can
      // simulate FK violations without standing up a real Postgres.
      if (!(err instanceof Error)) return false
      const code = 'code' in err ? ((err as { code?: string }).code ?? undefined) : undefined
      const constraint =
        'constraint' in err ? ((err as { constraint?: string }).constraint ?? undefined) : undefined
      const isFkBySqlstate = code === '23503'
      const isFkByMessage = !isFkBySqlstate && /foreign key|violates|reference/i.test(err.message)
      if (!isFkBySqlstate && !isFkByMessage) return false
      if (expectedConstraint === undefined) return true
      return constraint === expectedConstraint
    },
    listHashLists: inertList,
    listHashListsPaginated: mock(async () => ({ items: [], total: 0 })),
    // Real getHashItems returns `{items, total, limit, offset} | null`.
    // Mock shape pinned via `satisfies` so the mirror-service-not-schema
    // convention's static-fixture pattern fails type-check (in any tool
    // that includes test files) if the service shape drifts. The prior
    // `{items, total}` stub missed the limit/offset fields the route
    // passes through to the wire (and the null branch the route maps
    // to 404).
    getHashItems: mock(
      async () =>
        ({ items: [], total: 0, limit: 50, offset: 0 }) satisfies NonNullable<
          Awaited<ReturnType<typeof import('../../src/services/resources.js').getHashItems>>
        >
    ),
    getHashListStats: mock(async () => ({
      totalCount: 0,
      crackedCount: 0,
      crackRate: 0,
    })),
    listHashTypes: inertList,
    getHashTypeById: mock(async () => null),
    // Generic resource flow
    listResources: inertList,
    listResourcesPaginated: mock(async () => ({ items: [], total: 0 })),
    createResource: mock(async () => ({ id: 1 })),
    getResourceById: mock(async () => null),
    uploadResourceFile: mock(async () => ({ key: 'k', size: 0 })),
    deleteResource: mock(async () => ({ kind: 'deleted' as const })),
    getResourcePresignedUrl: mock(async () => 'https://example/test'),
    // `services/campaigns.js` (loaded for real by this app's route
    // registration) imports `latchResourcePermanent` at module scope
    // (ADR-0019 / issue #106 U3). GOTCHAS.md "mock.module merges exports" —
    // every consumer's top-level import must be present on the mock
    // factory or the import fails at load time for every test file in
    // this run.
    latchResourcePermanent: mock(async () => undefined),
    // Real getAgentDownloadUrl returns `{url, expiresIn} | null`. No
    // dashboard route consumes this service from this test file's
    // surface, but `routes/agent/index.ts` imports the function at
    // module-load time. Bun's `mock.module` MERGES - non-mocked
    // exports pass through to the real module (per GOTCHAS.md "Shared
    // module cache"). However, the real `services/resources.ts` pulls
    // in DB / S3 modules that this test's mock graph doesn't provide,
    // so the real export can't load cleanly; providing an explicit
    // mock here keeps the merged namespace import-safe for transitive
    // consumers. Pinned via `satisfies` per the convention's static-
    // fixture pattern.
    getAgentDownloadUrl: mock(
      async () =>
        ({ url: 'https://example/test', expiresIn: 600 }) satisfies NonNullable<
          Awaited<ReturnType<typeof import('../../src/services/resources.js').getAgentDownloadUrl>>
        >
    ),
    // String helper used by results routes.
    escapeLike: (s: string) => s,
    // Chunked upload
    initiateChunkedUpload: mock(async () => ({ uploadId: 'u', resourceId: 1 })),
    uploadChunkPart: mockUploadChunkPart,
    completeChunkedUpload: mockCompleteChunkedUpload,
    abortChunkedUpload: noop,
    getChunkedUploadStatus: mock(async () => ({ parts: [] })),
    // Error classes - the route imports these as values so we must
    // re-export classes that `instanceof` will match against the
    // synthetic errors we throw from the upload mock below.
    UploadTooLargeError: UploadTooLargeErrorMock,
    ResourceInUseError: ResourceInUseErrorMock,
    UploadResourceNotFoundError: UploadResourceNotFoundErrorMock,
    MAX_DIRECT_UPLOAD_BYTES: 10 * 1024 * 1024,
  }))

  // The hash-analysis service is imported by the routes for the
  // detect-hash-type endpoint. Kept inert so the static import resolves.
  mock.module('../../src/services/hash-analysis.js', () => ({
    guessHashType: () => [],
  }))

  // Stub db + ioredis to keep src/index.ts evaluation cheap.
  mock.module('../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
    },
    client: {},
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

  const { app } = await import('../../src/index.js')

  const HASH_LISTS_URL = '/api/v1/dashboard/resources/hash-lists'

  // Origin + Host satisfy the CSRF same-origin guard mounted on the
  // dashboard surface (PR review S-H4 follow-up). Same-origin values
  // satisfy the strict cookie-present branch; tests intentionally
  // exercising cross-origin would override.
  function makeHeaders(extra: Record<string, string> = {}) {
    return {
      cookie: ADMIN_COOKIE,
      'x-project-id': '1',
      origin: 'http://lab.local',
      host: 'lab.local',
      ...extra,
    }
  }

  // Helper to build a multipart form body with deterministic boundary.
  function buildMultipart(
    parts: Array<{ name: string; value: string | { filename: string; content: string } }>
  ): { body: string; boundary: string } {
    const boundary = '----HHTest1234567890'
    const lines: string[] = []
    for (const part of parts) {
      lines.push(`--${boundary}`)
      if (typeof part.value === 'string') {
        lines.push(`Content-Disposition: form-data; name="${part.name}"`)
        lines.push('')
        lines.push(part.value)
      } else {
        lines.push(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.value.filename}"`
        )
        lines.push('Content-Type: text/plain')
        lines.push('')
        lines.push(part.value.content)
      }
    }
    lines.push(`--${boundary}--`)
    lines.push('')
    return { body: lines.join('\r\n'), boundary }
  }

  function multipartHeaders(boundary: string) {
    return makeHeaders({ 'content-type': `multipart/form-data; boundary=${boundary}` })
  }

  function jsonHeaders() {
    return makeHeaders({ 'content-type': 'application/json' })
  }

  describe('POST /hash-lists - multipart branch (one-shot upload)', () => {
    it('happy path: creates row, uploads, enqueues, returns 202 with processing status', async () => {
      mockCreateHashList.mockReset()
      mockCreateHashList.mockImplementation(async (data) =>
        makeHashList({ name: data.name, projectId: data.projectId })
      )
      mockUploadHashListFile.mockReset()
      mockUploadHashListFile.mockImplementation(async () => ({ key: 'k', size: 10 }))
      mockImportHashList.mockReset()
      mockImportHashList.mockImplementation(async () => ({
        status: 'processing' as const,
        queued: true,
      }))
      mockGetHashListById.mockReset()
      mockGetHashListById.mockImplementation(async (id: number) =>
        makeHashList({ id, status: 'processing' })
      )
      mockDeleteHashList.mockReset()

      const { body, boundary } = buildMultipart([
        { name: 'name', value: 'happy-list' },
        { name: 'file', value: { filename: 'hashes.txt', content: 'abc\n' } },
      ])

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: multipartHeaders(boundary),
        body,
      })

      expect(res.status).toBe(202)
      const json = (await res.json()) as { hashList?: { status?: string } }
      expect(json.hashList?.status).toBe('processing')
      expect(mockCreateHashList).toHaveBeenCalledTimes(1)
      expect(mockUploadHashListFile).toHaveBeenCalledTimes(1)
      expect(mockImportHashList).toHaveBeenCalledTimes(1)
      // No rollback on the happy path.
      expect(mockDeleteHashList).not.toHaveBeenCalled()
    })

    it('missing file field returns 400 VALIDATION_ERROR', async () => {
      mockCreateHashList.mockReset()
      mockCreateHashList.mockImplementation(async (data) => makeHashList({ name: data.name }))

      const { body, boundary } = buildMultipart([{ name: 'name', value: 'no-file' }])

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: multipartHeaders(boundary),
        body,
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('VALIDATION_ERROR')
      expect(json.error?.message).toContain('file')
      expect(mockCreateHashList).not.toHaveBeenCalled()
    })

    it('missing name field returns 400 VALIDATION_ERROR', async () => {
      mockCreateHashList.mockReset()
      mockCreateHashList.mockImplementation(async (data) => makeHashList({ name: data.name }))

      const { body, boundary } = buildMultipart([
        { name: 'file', value: { filename: 'h.txt', content: 'abc' } },
      ])

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: multipartHeaders(boundary),
        body,
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('VALIDATION_ERROR')
      expect(json.error?.message).toContain('name')
      expect(mockCreateHashList).not.toHaveBeenCalled()
    })

    it('name longer than 255 chars returns 400 VALIDATION_ERROR', async () => {
      mockCreateHashList.mockReset()
      mockCreateHashList.mockImplementation(async (data) => makeHashList({ name: data.name }))

      const tooLong = 'x'.repeat(256)
      const { body, boundary } = buildMultipart([
        { name: 'name', value: tooLong },
        { name: 'file', value: { filename: 'h.txt', content: 'abc' } },
      ])

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: multipartHeaders(boundary),
        body,
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error?: { code?: string } }
      expect(json.error?.code).toBe('VALIDATION_ERROR')
      expect(mockCreateHashList).not.toHaveBeenCalled()
    })

    it('upload failure with UploadTooLargeError returns 413 and rolls back the DB row', async () => {
      mockCreateHashList.mockReset()
      mockCreateHashList.mockImplementation(async (data) =>
        makeHashList({ name: data.name, status: 'uploading' })
      )
      mockUploadHashListFile.mockReset()
      mockUploadHashListFile.mockImplementation(async () => {
        throw new UploadTooLargeErrorMock(20 * 1024 * 1024, 10 * 1024 * 1024)
      })
      mockImportHashList.mockReset()
      mockImportHashList.mockImplementation(async () => ({
        status: 'processing' as const,
        queued: true,
      }))
      mockDeleteHashList.mockReset()
      mockDeleteHashList.mockImplementation(async () => ({ kind: 'deleted' as const }))

      const { body, boundary } = buildMultipart([
        { name: 'name', value: 'too-big' },
        { name: 'file', value: { filename: 'big.txt', content: 'x' } },
      ])

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: multipartHeaders(boundary),
        body,
      })

      expect(res.status).toBe(413)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('PAYLOAD_TOO_LARGE')
      // DB row created, upload failed, row rolled back, parsing NOT enqueued.
      expect(mockCreateHashList).toHaveBeenCalledTimes(1)
      expect(mockUploadHashListFile).toHaveBeenCalledTimes(1)
      expect(mockDeleteHashList).toHaveBeenCalledTimes(1)
      expect(mockImportHashList).not.toHaveBeenCalled()
    })

    it('rejects with 411 LENGTH_REQUIRED on Transfer-Encoding: chunked multipart', async () => {
      mockCreateHashList.mockReset()
      mockUploadHashListFile.mockReset()
      const { body, boundary } = buildMultipart([
        { name: 'name', value: 'chunked' },
        { name: 'file', value: { filename: 'h.txt', content: 'abc\n' } },
      ])
      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: {
          ...multipartHeaders(boundary),
          'transfer-encoding': 'chunked',
        },
        body,
      })
      expect(res.status).toBe(411)
      const json = (await res.json()) as { error?: { code?: string } }
      expect(json.error?.code).toBe('LENGTH_REQUIRED')
      // Critical: rejected BEFORE the upload pipeline even started - chunked
      // multipart bypasses the Content-Length guard, so we close that door.
      expect(mockCreateHashList).not.toHaveBeenCalled()
      expect(mockUploadHashListFile).not.toHaveBeenCalled()
    })

    it('rejects with 413 BEFORE parseBody when content-length exceeds the wire cap', async () => {
      mockCreateHashList.mockReset()
      mockUploadHashListFile.mockReset()
      mockDeleteHashList.mockReset()
      mockImportHashList.mockReset()

      const { boundary } = buildMultipart([
        { name: 'name', value: 'huge' },
        { name: 'file', value: { filename: 'huge.bin', content: 'x' } },
      ])

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: { ...multipartHeaders(boundary), 'content-length': '999999999' },
        body: 'ignored - server rejects on header before reading',
      })

      expect(res.status).toBe(413)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('PAYLOAD_TOO_LARGE')
      // Critical: must NOT have invoked the upload pipeline. The whole
      // point of the headers-only guard is that hostile clients can't
      // make us buffer a multi-GB body before being rejected.
      expect(mockCreateHashList).not.toHaveBeenCalled()
      expect(mockUploadHashListFile).not.toHaveBeenCalled()
      expect(mockImportHashList).not.toHaveBeenCalled()
    })

    it('rejects with 400 VALIDATION_ERROR when hashTypeId is not a positive integer', async () => {
      mockCreateHashList.mockReset()
      const { body, boundary } = buildMultipart([
        { name: 'name', value: 'bad-type' },
        { name: 'hashTypeId', value: 'not-a-number' },
        { name: 'file', value: { filename: 'h.txt', content: 'abc\n' } },
      ])

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: multipartHeaders(boundary),
        body,
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('VALIDATION_ERROR')
      expect(json.error?.message).toContain('hashTypeId')
      expect(mockCreateHashList).not.toHaveBeenCalled()
    })

    it('rejects with 400 VALIDATION_ERROR when hashTypeId is negative or zero', async () => {
      mockCreateHashList.mockReset()
      const { body, boundary } = buildMultipart([
        { name: 'name', value: 'bad-type' },
        { name: 'hashTypeId', value: '-3' },
        { name: 'file', value: { filename: 'h.txt', content: 'abc\n' } },
      ])

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: multipartHeaders(boundary),
        body,
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('VALIDATION_ERROR')
      expect(mockCreateHashList).not.toHaveBeenCalled()
    })

    it('generic upload failure returns 503 STORAGE_UNAVAILABLE and rolls back', async () => {
      mockCreateHashList.mockReset()
      mockCreateHashList.mockImplementation(async (data) => makeHashList({ name: data.name }))
      mockUploadHashListFile.mockReset()
      mockUploadHashListFile.mockImplementation(async () => {
        throw new Error('S3 down')
      })
      mockDeleteHashList.mockReset()
      mockDeleteHashList.mockImplementation(async () => ({ kind: 'deleted' as const }))
      mockImportHashList.mockReset()
      mockImportHashList.mockImplementation(async () => ({
        status: 'processing' as const,
        queued: true,
      }))

      const { body, boundary } = buildMultipart([
        { name: 'name', value: 's3-down' },
        { name: 'file', value: { filename: 'h.txt', content: 'abc' } },
      ])

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: multipartHeaders(boundary),
        body,
      })

      expect(res.status).toBe(503)
      const json = (await res.json()) as { error?: { code?: string } }
      expect(json.error?.code).toBe('STORAGE_UNAVAILABLE')
      expect(mockDeleteHashList).toHaveBeenCalledTimes(1)
      expect(mockImportHashList).not.toHaveBeenCalled()
    })

    it('createHashList returning null surfaces 503 STORAGE_UNAVAILABLE and skips upload', async () => {
      mockCreateHashList.mockReset()
      // Cast: production return is HashListRow but the route guards `!created`,
      // so the test exercises the null branch.
      mockCreateHashList.mockImplementation(
        async () => null as unknown as ReturnType<typeof makeHashList>
      )
      mockUploadHashListFile.mockReset()
      mockUploadHashListFile.mockImplementation(async () => ({ key: 'k', size: 0 }))
      mockImportHashList.mockReset()
      mockImportHashList.mockImplementation(async () => ({
        status: 'processing' as const,
        queued: true,
      }))

      const { body, boundary } = buildMultipart([
        { name: 'name', value: 'no-row' },
        { name: 'file', value: { filename: 'h.txt', content: 'abc' } },
      ])

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: multipartHeaders(boundary),
        body,
      })

      expect(res.status).toBe(503)
      const json = (await res.json()) as { error?: { code?: string } }
      expect(json.error?.code).toBe('STORAGE_UNAVAILABLE')
      expect(mockUploadHashListFile).not.toHaveBeenCalled()
    })

    it('importHashList queue error returns 503 SERVICE_UNAVAILABLE', async () => {
      mockCreateHashList.mockReset()
      mockCreateHashList.mockImplementation(async (data) => makeHashList({ name: data.name }))
      mockUploadHashListFile.mockReset()
      mockUploadHashListFile.mockImplementation(async () => ({ key: 'k', size: 5 }))
      mockImportHashList.mockReset()
      mockImportHashList.mockImplementation(async () => ({ error: 'Queue offline' }))
      mockDeleteHashList.mockReset()

      const { body, boundary } = buildMultipart([
        { name: 'name', value: 'queue-down' },
        { name: 'file', value: { filename: 'h.txt', content: 'abc' } },
      ])

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: multipartHeaders(boundary),
        body,
      })

      expect(res.status).toBe(503)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('SERVICE_UNAVAILABLE')
      expect(json.error?.message).toContain('Queue offline')
    })
  })

  describe('POST /hash-lists - JSON branch (legacy create-empty)', () => {
    it('happy path: creates an empty hash list and returns 201', async () => {
      mockCreateHashList.mockReset()
      mockCreateHashList.mockImplementation(async (data) =>
        makeHashList({ name: data.name, projectId: data.projectId, status: 'pending' })
      )

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: 'legacy-list' }),
      })

      expect(res.status).toBe(201)
      const json = (await res.json()) as { hashList?: { name?: string } }
      expect(json.hashList?.name).toBe('legacy-list')
      expect(mockCreateHashList).toHaveBeenCalledTimes(1)
    })

    it('malformed JSON body returns 400 VALIDATION_ERROR', async () => {
      mockCreateHashList.mockReset()

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: jsonHeaders(),
        body: '{not valid json',
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error?: { code?: string } }
      expect(json.error?.code).toBe('VALIDATION_ERROR')
      expect(mockCreateHashList).not.toHaveBeenCalled()
    })

    it('JSON missing required name field returns 400 VALIDATION_ERROR', async () => {
      mockCreateHashList.mockReset()

      const res = await app.request(HASH_LISTS_URL, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ hashTypeId: 100 }),
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error?: { code?: string } }
      expect(json.error?.code).toBe('VALIDATION_ERROR')
      expect(mockCreateHashList).not.toHaveBeenCalled()
    })
  })

  describe('chunked-upload 404 mapping', () => {
    // The dashboard spec documents `404 ResourceNotFound` on the
    // `PUT /upload/{id}/part/{n}` and `POST /upload/{id}/complete`
    // routes. The runtime contract is only correct if the handler
    // actually translates `UploadResourceNotFoundError` from the
    // service layer into that 404 - otherwise the documented response
    // is unreachable and route-as-spec lies about wire behavior.
    // These two tests pin the mapping.

    const UPLOAD_PART_URL =
      '/api/v1/dashboard/resources/upload/u-1/part/1?resourceId=42&resourceType=hash-lists'
    const UPLOAD_COMPLETE_URL = '/api/v1/dashboard/resources/upload/u-1/complete'

    it('PUT /upload/{id}/part/{n} maps UploadResourceNotFoundError to 404 RESOURCE_NOT_FOUND', async () => {
      mockUploadChunkPart.mockReset()
      mockUploadChunkPart.mockImplementation(async () => {
        throw new UploadResourceNotFoundErrorMock(42, 'hash-lists')
      })

      const res = await app.request(UPLOAD_PART_URL, {
        method: 'PUT',
        headers: makeHeaders({ 'content-type': 'application/octet-stream' }),
        body: new Uint8Array([1, 2, 3]),
      })

      expect(res.status).toBe(404)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('RESOURCE_NOT_FOUND')
      // Pin the generic client message - the handler does NOT echo
      // err.message back, matching the uploadStatus 404 wording for
      // wire-response consistency. resourceId/resourceType are logged
      // server-side at debug level only.
      expect(json.error?.message).toBe('Upload not found')
    })

    it('POST /upload/{id}/complete maps UploadResourceNotFoundError to 404 RESOURCE_NOT_FOUND', async () => {
      mockCompleteChunkedUpload.mockReset()
      mockCompleteChunkedUpload.mockImplementation(async () => {
        throw new UploadResourceNotFoundErrorMock(42, 'hash-lists')
      })

      const res = await app.request(UPLOAD_COMPLETE_URL, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          parts: [{ partNumber: 1, etag: 'e' }],
          resourceId: 42,
          resourceType: 'hash-lists',
        }),
      })

      expect(res.status).toBe(404)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('RESOURCE_NOT_FOUND')
      // Same generic-message pin as the upload-part case above.
      expect(json.error?.message).toBe('Upload not found')
    })
  })

  describe('PATCH /hash-lists/{id} - set hash type (issue #163)', () => {
    const SET_TYPE_URL = '/api/v1/dashboard/resources/hash-lists/42'

    it('happy path: returns 200 with the updated row when service resolves', async () => {
      mockSetHashListType.mockReset()
      mockSetHashListType.mockImplementation(async (id, projectId, hashTypeId) =>
        makeHashList({ id, projectId, hashTypeId })
      )

      const res = await app.request(SET_TYPE_URL, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ hashTypeId: 1000 }),
      })

      expect(res.status).toBe(200)
      const json = (await res.json()) as {
        hashList?: { id?: number; hashTypeId?: number }
      }
      expect(json.hashList?.id).toBe(42)
      expect(json.hashList?.hashTypeId).toBe(1000)
      // Service called with (id, projectId, hashTypeId) - pin the
      // ordering so a future refactor that swaps argument positions
      // gets caught at the route boundary.
      expect(mockSetHashListType).toHaveBeenCalledTimes(1)
      const callArgs = mockSetHashListType.mock.calls[0]
      expect(callArgs?.[0]).toBe(42)
      expect(callArgs?.[2]).toBe(1000)
    })

    it('returns 404 RESOURCE_NOT_FOUND when service returns null (cross-project or deleted)', async () => {
      mockSetHashListType.mockReset()
      mockSetHashListType.mockImplementation(async () => null)

      const res = await app.request(SET_TYPE_URL, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ hashTypeId: 1000 }),
      })

      expect(res.status).toBe(404)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('RESOURCE_NOT_FOUND')
      // Generic message - no existence disclosure between cross-
      // project miss and genuinely-deleted row.
      expect(json.error?.message).toBe('Hash list not found')
    })

    it('returns 400 VALIDATION_ERROR for non-positive integer id', async () => {
      mockSetHashListType.mockReset()
      const res = await app.request('/api/v1/dashboard/resources/hash-lists/0', {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ hashTypeId: 1000 }),
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('VALIDATION_ERROR')
      // Service not invoked when the path-param guard rejects.
      expect(mockSetHashListType).not.toHaveBeenCalled()
    })

    it('returns 400 VALIDATION_ERROR for non-positive hashTypeId in body', async () => {
      mockSetHashListType.mockReset()
      const res = await app.request(SET_TYPE_URL, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ hashTypeId: 0 }),
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('VALIDATION_ERROR')
      expect(mockSetHashListType).not.toHaveBeenCalled()
    })

    it('maps Postgres FK violation (SQLSTATE 23503) on the hash_type_id constraint to 400 "Unknown hashTypeId"', async () => {
      mockSetHashListType.mockReset()
      mockSetHashListType.mockImplementation(async () => {
        const err = new Error(
          'insert or update on table "hash_lists" violates foreign key constraint "hash_lists_hash_type_id_hash_types_id_fk"'
        )
        // Drizzle/postgres-js surfaces SQLSTATE 23503 on err.code and
        // the constraint name on err.constraint for FK violations.
        ;(err as Error & { code?: string; constraint?: string }).code = '23503'
        ;(err as Error & { code?: string; constraint?: string }).constraint =
          'hash_lists_hash_type_id_hash_types_id_fk'
        throw err
      })

      const res = await app.request(SET_TYPE_URL, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ hashTypeId: 99999 }),
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(json.error?.code).toBe('VALIDATION_ERROR')
      expect(json.error?.message).toBe('Unknown hashTypeId')
    })

    it('does NOT map an unrelated FK violation to 400 - falls through to 5xx', async () => {
      mockSetHashListType.mockReset()
      mockSetHashListType.mockImplementation(async () => {
        // Simulate a different FK violation (e.g., a future trigger
        // that references another table). The isForeignKeyViolation
        // helper's constraint-name check must keep this as a 5xx so
        // we don't tell the user "Unknown hashTypeId" when the real
        // problem is elsewhere.
        const err = new Error(
          'insert or update on table "hash_lists" violates foreign key constraint "some_other_fk"'
        )
        ;(err as Error & { code?: string; constraint?: string }).code = '23503'
        ;(err as Error & { code?: string; constraint?: string }).constraint = 'some_other_fk'
        throw err
      })

      const res = await app.request(SET_TYPE_URL, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ hashTypeId: 1000 }),
      })

      expect(res.status).toBeGreaterThanOrEqual(500)
    })

    it('rethrows non-FK errors as 5xx so transient infra failure surfaces, not as 400', async () => {
      mockSetHashListType.mockReset()
      mockSetHashListType.mockImplementation(async () => {
        throw new Error('ECONNREFUSED - database unreachable')
      })

      const res = await app.request(SET_TYPE_URL, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ hashTypeId: 1000 }),
      })

      // Tighter than "not 400" - a regression that returns 200 with
      // an empty body would have escaped the original assertion.
      expect(res.status).toBeGreaterThanOrEqual(500)
    })
  })
} // end IS_ISOLATED
