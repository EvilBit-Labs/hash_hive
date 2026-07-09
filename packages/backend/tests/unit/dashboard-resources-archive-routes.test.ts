/**
 * Route-contract tests for the hash-list / resource archive & restore
 * endpoints (ADR-0019, issue #106 U4) and the `showArchived` list filter.
 * Mirrors `dashboard-campaigns-routes.test.ts`'s "archive/restore"
 * describe block, adapted to the resources surface's
 * `resources-archive-routes.ts` (hash lists) and the generic
 * wordlist/rulelist/masklist factory in `resources-generic.ts`.
 *
 * Runs in an isolated test phase via `RESOURCES_ARCHIVE_ROUTES_TEST_ISOLATED`
 * because this file mocks `services/resources.js` and
 * `services/resources-archive.js` wholesale — the mock.module calls leak
 * process-wide and would clobber `dashboard-resources-routes.test.ts` /
 * `resources-delete.test.ts`, which rely on different stub shapes for the
 * same modules.
 */
import { describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['RESOURCES_ARCHIVE_ROUTES_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('dashboard-resources-archive-routes (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-resources-archive-routes] skipped - set RESOURCES_ARCHIVE_ROUTES_TEST_ISOLATED=1 to run; the route suite did NOT execute in this phase.'
      )
      expect(process.env['RESOURCES_ARCHIVE_ROUTES_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── Mock BetterAuth + project membership ───────────────────────────

  const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
  const VIEWER_COOKIE = 'hh.session_token=valid-viewer-session'

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
                projectId: 1,
              },
            }
          }
          if (cookie.includes('valid-viewer-session')) {
            return {
              user: {
                id: '2',
                email: 'viewer@test.local',
                name: 'Viewer',
                emailVerified: true,
                image: null,
                roles: [],
              },
              session: {
                id: 'sess-viewer',
                userId: '2',
                token: 'tok-viewer',
                expiresAt: new Date(Date.now() + 3600000),
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
      if (userId === 2) {
        return { id: 2, projects: [{ projectId: 1, roles: ['viewer'] }] }
      }
      return null
    },
    findProjectMembership: async (userId: number, projectId: number) => {
      if (projectId !== 1) return null
      if (userId === 1) return { projectId: 1, roles: ['admin'] }
      if (userId === 2) return { projectId: 1, roles: ['viewer'] }
      return null
    },
    getUserLastProjectId: async () => null,
    setUserLastProjectIdIfMember: async () => 1,
    setUserLastProjectId: async () => undefined,
    issueUserApiKey: mock(async () => ({ apiKey: 'cst_test', metadata: null })),
    revokeUserApiKey: mock(async () => undefined),
    getUserApiKeyMetadata: mock(async () => null),
  }))

  // ─── Mock the Resources Service Layer ───────────────────────────────
  //
  // Every export the resources route surface touches at module scope
  // must be present on the factory object below (Bun's mock.module fully
  // replaces the module; a missing named export throws a SyntaxError at
  // import time, not just at call time — see GOTCHAS.md "mock.module
  // merges exports"). `listHashLists` / `listResources` are controllable
  // mocks (not inert stubs) so the `showArchived` pass-through tests can
  // assert the exact opts object the route forwarded.
  const mockListHashLists = mock(async (_projectId: number, _opts?: unknown) => [])
  const mockListResources = mock(async (_table: unknown, _projectId: number, _opts?: unknown) => [])
  const inertList = mock(async () => [])

  mock.module('../../src/services/resources.js', () => ({
    createHashList: mock(async () => ({ id: 1 })),
    uploadHashListFile: mock(async () => ({ key: 'k', size: 0 })),
    importHashList: mock(async () => ({ status: 'processing' as const, queued: true })),
    deleteHashList: mock(async () => ({ kind: 'deleted' as const })),
    getHashListById: mock(async () => null),
    setHashListType: mock(async () => null),
    isForeignKeyViolation: () => false,
    listHashLists: mockListHashLists,
    listHashListsPaginated: mock(async () => ({ items: [], total: 0 })),
    // `resources-archive.ts` (real module, unmocked below by this file's
    // `services/resources-archive.js` mock which replaces it wholesale)
    // imports `entityTypeForTable` from here at module scope only when
    // the real archive service loads — mocked out below, so this stub is
    // for the transitive static-import binding only.
    entityTypeForTable: mock(() => 'word_list' as const),
    getHashItems: mock(async () => ({ items: [], total: 0, limit: 50, offset: 0 })),
    getHashListStats: mock(async () => ({ totalCount: 0, crackedCount: 0, crackRate: 0 })),
    listHashTypes: inertList,
    getHashTypeById: mock(async () => null),
    listResources: mockListResources,
    listResourcesPaginated: mock(async () => ({ items: [], total: 0 })),
    createResource: mock(async () => ({ id: 1 })),
    getResourceById: mock(async () => null),
    uploadResourceFile: mock(async () => ({ key: 'k', size: 0 })),
    deleteResource: mock(async () => ({ kind: 'deleted' as const })),
    getResourcePresignedUrl: mock(async () => 'https://example/test'),
    latchResourcePermanent: mock(async () => undefined),
    getAgentDownloadUrl: mock(async () => ({
      url: 'https://example/test',
      expiresIn: 600,
      checksum: null,
      size: null,
      encoding: null,
    })),
    escapeLike: (s: string) => s,
    initiateChunkedUpload: mock(async () => ({ uploadId: 'u', resourceId: 1 })),
    uploadChunkPart: mock(async () => ({ etag: 'e' })),
    completeChunkedUpload: mock(async () => ({ resourceId: 1 })),
    abortChunkedUpload: mock(async () => undefined),
    getChunkedUploadStatus: mock(async () => ({ parts: [] })),
    UploadTooLargeError: class UploadTooLargeErrorMock extends Error {},
    ResourceInUseError: class ResourceInUseErrorMock extends Error {},
    UploadResourceNotFoundError: class UploadResourceNotFoundErrorMock extends Error {},
    // Reclaimed-shell re-upload checksum mismatch (issue #106 U12 / R12) —
    // the route imports this as a value for `instanceof`; no test in this
    // archive/restore-focused file exercises it, but the named export must
    // be present or the import fails to link.
    ChecksumMismatchError: class ChecksumMismatchErrorMock extends Error {},
    // Chunked-upload restore-after-reclaim target that isn't actually a
    // reclaimed shell (issue #106 F3 code review) — same link-only
    // requirement as ChecksumMismatchError above.
    ResourceNotReclaimedShellError: class ResourceNotReclaimedShellErrorMock extends Error {},
    MAX_DIRECT_UPLOAD_BYTES: 10 * 1024 * 1024,
  }))

  // ─── Mock the Resources Archive Service Layer (U3) ──────────────────
  //
  // The route handlers under test call these directly; per-test
  // `mockImplementationOnce` overrides drive the per-id outcome
  // assertions below.
  type ArchiveOutcome = { id: number; outcome: string }
  const mockArchiveHashLists = mock(async (_projectId: number, ids: number[], _actor?: unknown) =>
    ids.map((id): ArchiveOutcome => ({ id, outcome: 'archived' }))
  )
  const mockRestoreHashLists = mock(async (_projectId: number, ids: number[], _actor?: unknown) =>
    ids.map((id): ArchiveOutcome => ({ id, outcome: 'restored' }))
  )
  const mockArchiveResources = mock(
    async (_table: unknown, _projectId: number, ids: number[], _actor?: unknown) =>
      ids.map((id): ArchiveOutcome => ({ id, outcome: 'archived' }))
  )
  const mockRestoreResources = mock(
    async (_table: unknown, _projectId: number, ids: number[], _actor?: unknown) =>
      ids.map((id): ArchiveOutcome => ({ id, outcome: 'restored' }))
  )

  mock.module('../../src/services/resources-archive.js', () => ({
    archiveHashLists: mockArchiveHashLists,
    restoreHashLists: mockRestoreHashLists,
    archiveResources: mockArchiveResources,
    restoreResources: mockRestoreResources,
    // `queue/workers/blob-reclamation.js` (issue #106 U11, loaded for real
    // via `queue/manager.js`'s static import, part of this app's graph)
    // imports `attackFkColumnForTable` at module scope. GOTCHAS.md
    // "mock.module merges exports" — the named import fails to link if
    // this mock omits it. No test in this file exercises reclamation.
    attackFkColumnForTable: mock(() => ({}) as never),
  }))

  mock.module('../../src/services/hash-analysis.js', () => ({
    guessHashType: () => [],
  }))

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

  const RESOURCES = '/api/v1/dashboard/resources'

  function makeHeaders(cookie: string = ADMIN_COOKIE, extra: Record<string, string> = {}) {
    return {
      cookie,
      'x-project-id': '1',
      origin: 'http://lab.local',
      host: 'lab.local',
      ...extra,
    }
  }

  function jsonHeaders(cookie: string = ADMIN_COOKIE) {
    return makeHeaders(cookie, { 'content-type': 'application/json' })
  }

  // ─── Hash-list archive / restore ─────────────────────────────────────

  describe('POST /resources/hash-lists/archive', () => {
    it('archives hash lists and returns per-id outcomes (admin)', async () => {
      mockArchiveHashLists.mockClear()
      const res = await app.request(`${RESOURCES}/hash-lists/archive`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ids: [10, 11] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results?: ArchiveOutcome[] }
      expect(body.results).toEqual([
        { id: 10, outcome: 'archived' },
        { id: 11, outcome: 'archived' },
      ])
      expect(mockArchiveHashLists).toHaveBeenCalledWith(1, [10, 11], {
        actorType: 'user',
        actorId: 1,
      })
    })

    it('returns 403 when a viewer attempts to archive', async () => {
      const res = await app.request(`${RESOURCES}/hash-lists/archive`, {
        method: 'POST',
        headers: jsonHeaders(VIEWER_COOKIE),
        body: JSON.stringify({ ids: [10] }),
      })
      expect(res.status).toBe(403)
    })

    it('returns 400 when ids exceeds the 200-item bulk cap', async () => {
      const ids = Array.from({ length: 201 }, (_, i) => i + 1)
      const res = await app.request(`${RESOURCES}/hash-lists/archive`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ids }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 on an empty ids array', async () => {
      const res = await app.request(`${RESOURCES}/hash-lists/archive`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ids: [] }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /resources/hash-lists/restore', () => {
    it('restores hash lists (admin)', async () => {
      const res = await app.request(`${RESOURCES}/hash-lists/restore`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ids: [10] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results?: ArchiveOutcome[] }
      expect(body.results).toEqual([{ id: 10, outcome: 'restored' }])
    })

    it('returns 403 when a viewer attempts to restore', async () => {
      const res = await app.request(`${RESOURCES}/hash-lists/restore`, {
        method: 'POST',
        headers: jsonHeaders(VIEWER_COOKIE),
        body: JSON.stringify({ ids: [10] }),
      })
      expect(res.status).toBe(403)
    })
  })

  // ─── Generic resource (wordlists/rulelists/masklists) archive/restore ─

  describe('POST /resources/wordlists/archive + /restore', () => {
    it('archives wordlists and returns per-id outcomes (admin)', async () => {
      mockArchiveResources.mockClear()
      const res = await app.request(`${RESOURCES}/wordlists/archive`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ids: [20] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results?: ArchiveOutcome[] }
      expect(body.results).toEqual([{ id: 20, outcome: 'archived' }])
      expect(mockArchiveResources).toHaveBeenCalledTimes(1)
      const call = mockArchiveResources.mock.calls[0]
      expect(call?.[1]).toBe(1) // projectId
      expect(call?.[2]).toEqual([20]) // ids
    })

    it('restores wordlists (admin)', async () => {
      const res = await app.request(`${RESOURCES}/wordlists/restore`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ids: [20] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results?: ArchiveOutcome[] }
      expect(body.results).toEqual([{ id: 20, outcome: 'restored' }])
    })

    it('returns 403 when a viewer attempts to archive a wordlist', async () => {
      const res = await app.request(`${RESOURCES}/wordlists/archive`, {
        method: 'POST',
        headers: jsonHeaders(VIEWER_COOKIE),
        body: JSON.stringify({ ids: [20] }),
      })
      expect(res.status).toBe(403)
    })
  })

  describe('rulelists/masklists archive routes are also registered', () => {
    it('archives a rulelist entry', async () => {
      const res = await app.request(`${RESOURCES}/rulelists/archive`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ids: [30] }),
      })
      expect(res.status).toBe(200)
    })

    it('archives a masklist entry', async () => {
      const res = await app.request(`${RESOURCES}/masklists/archive`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ids: [40] }),
      })
      expect(res.status).toBe(200)
    })
  })

  // ─── showArchived list filter ────────────────────────────────────────

  describe('GET /resources/hash-lists showArchived filter', () => {
    it('defaults to excluding archived rows', async () => {
      mockListHashLists.mockClear()
      const res = await app.request(`${RESOURCES}/hash-lists`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      expect(mockListHashLists).toHaveBeenCalledWith(1, { showArchived: false })
    })

    it('passes showArchived=true through to the service', async () => {
      mockListHashLists.mockClear()
      const res = await app.request(`${RESOURCES}/hash-lists?showArchived=true`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      expect(mockListHashLists).toHaveBeenCalledWith(1, { showArchived: true })
    })
  })

  describe('GET /resources/wordlists showArchived filter', () => {
    it('defaults to excluding archived rows', async () => {
      mockListResources.mockClear()
      const res = await app.request(`${RESOURCES}/wordlists`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      expect(mockListResources).toHaveBeenCalledTimes(1)
      const call = mockListResources.mock.calls[0]
      expect(call?.[1]).toBe(1)
      expect(call?.[2]).toEqual({ showArchived: false })
    })

    it('passes showArchived=true through to the service', async () => {
      mockListResources.mockClear()
      const res = await app.request(`${RESOURCES}/wordlists?showArchived=true`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const call = mockListResources.mock.calls[0]
      expect(call?.[2]).toEqual({ showArchived: true })
    })
  })
}
