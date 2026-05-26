/**
 * Route-level contract tests for U5 — content-type-aware
 * `POST /api/v1/dashboard/resources/hash-lists`. Covers both branches of
 * the dispatcher (multipart one-shot upload, legacy JSON create-empty)
 * because `tests/integration/hash-list-pipeline.test.ts` bypasses the
 * route and invokes the parser worker directly.
 *
 * Runs in an isolated test phase via the `RESOURCES_ROUTES_TEST_ISOLATED`
 * env gate because this file mocks `services/resources.js` wholesale —
 * the mock leaks process-wide and would clobber the un-mocked imports
 * `resources-delete.test.ts` and `hash-list-pipeline.test.ts` rely on.
 * Mirrors the dashboard-campaigns-routes isolation pattern.
 */
import { describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['RESOURCES_ROUTES_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('dashboard-resources-routes (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-resources-routes] skipped — set RESOURCES_ROUTES_TEST_ISOLATED=1 to run; the route suite did NOT execute in this phase.'
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

  // Default behaviors — overridden per-test via mockResolvedValueOnce / mockReset.
  const mockCreateHashList = mock(async (data: { projectId: number; name: string }) =>
    makeHashList({ name: data.name, projectId: data.projectId })
  )
  const mockUploadHashListFile = mock(async () => ({ key: 'some/key', size: 123 }))
  const mockImportHashList = mock(async () => ({ status: 'processing' as const, queued: true }))
  const mockDeleteHashList = mock(async () => true)
  const mockGetHashListById = mock(async (id: number) => makeHashList({ id, status: 'processing' }))

  // Surfaces used by the broader service surface — kept inert so the
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

  mock.module('../../src/services/resources.js', () => ({
    // Hash list flow
    createHashList: mockCreateHashList,
    uploadHashListFile: mockUploadHashListFile,
    importHashList: mockImportHashList,
    deleteHashList: mockDeleteHashList,
    getHashListById: mockGetHashListById,
    listHashLists: inertList,
    listHashListsPaginated: mock(async () => ({ items: [], total: 0 })),
    getHashItems: mock(async () => ({ items: [], total: 0 })),
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
    deleteResource: mock(async () => true),
    getResourcePresignedUrl: mock(async () => 'https://example/test'),
    getAgentDownloadUrl: mock(async () => 'https://example/test'),
    // String helper used by results routes.
    escapeLike: (s: string) => s,
    // Chunked upload
    initiateChunkedUpload: mock(async () => ({ uploadId: 'u', resourceId: 1 })),
    uploadChunkPart: mock(async () => ({ etag: 'e' })),
    completeChunkedUpload: mock(async () => ({ key: 'k' })),
    abortChunkedUpload: noop,
    getChunkedUploadStatus: mock(async () => ({ parts: [] })),
    // Error classes — the route imports these as values so we must
    // re-export classes that `instanceof` will match against the
    // synthetic errors we throw from the upload mock below.
    UploadTooLargeError: UploadTooLargeErrorMock,
    ResourceInUseError: ResourceInUseErrorMock,
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

  function makeHeaders(extra: Record<string, string> = {}) {
    return { cookie: ADMIN_COOKIE, 'x-project-id': '1', ...extra }
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

  describe('POST /hash-lists — multipart branch (one-shot upload)', () => {
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
      mockDeleteHashList.mockImplementation(async () => true)

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
      // Critical: rejected BEFORE the upload pipeline even started — chunked
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
        body: 'ignored — server rejects on header before reading',
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
      mockDeleteHashList.mockImplementation(async () => true)
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

  describe('POST /hash-lists — JSON branch (legacy create-empty)', () => {
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
} // end IS_ISOLATED
