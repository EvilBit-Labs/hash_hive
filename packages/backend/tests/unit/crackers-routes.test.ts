/**
 * Cracker dashboard + agent route contract tests.
 *
 * Validates auth gates, validation errors, and the typed-error mapping
 * for the cracker routes. Mocks DB and storage modules so the suite
 * runs without infrastructure. Mirrors the mock pattern in
 * `dashboard-api-contract.test.ts` but is scoped to the cracker
 * surface to keep the test file focused.
 *
 * Service-layer behaviors (engine normalization, version comparison,
 * unique-violation detection, fileRef projection) are covered in
 * `crackers.test.ts` directly against the pure helpers.
 */
import { describe, expect, it, mock } from 'bun:test'

// Pull the real compareCrackerVersions in BEFORE mock.module runs so the mock
// can re-export it. mock.module is process-global in bun:test; the previous
// approach of inlining the algorithm duplicated ~70 lines of behavior and
// risked drift between this file and src/services/crackers.ts.
import { compareCrackerVersions as realCompareCrackerVersions } from '../../src/services/crackers.js'

// ─── Mock BetterAuth ─────────────────────────────────────────────────

const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
const VIEWER_COOKIE = 'hh.session_token=valid-viewer-session'
const AGENT_TOKEN = 'test-agent-preshared-token'

mock.module('../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get('cookie') ?? ''
        if (cookie.includes('valid-admin-session') || cookie.includes('valid-viewer-session')) {
          const isAdmin = cookie.includes('valid-admin-session')
          return {
            user: {
              id: isAdmin ? '1' : '2',
              email: isAdmin ? 'admin@test.local' : 'viewer@test.local',
              name: isAdmin ? 'Admin' : 'Viewer',
              emailVerified: true,
              image: null,
              // Global capability tier (users.roles). Crackers are
              // cluster-wide resources gated by global requireRole, so
              // the session must surface roles -- per-project
              // membership alone isn't enough.
              roles: isAdmin ? ['admin'] : ['analyst'],
            },
            session: {
              id: 'sess',
              userId: isAdmin ? '1' : '2',
              token: 'tok',
              expiresAt: new Date(Date.now() + 3600000),
              // session.projectId is null in this suite; crackers
              // endpoints use the global tier guard, not project scope.
              projectId: null,
            },
          }
        }
        return null
      },
    },
    handler: async () => new Response('ok'),
  },
}))

// ─── Mock Auth Service Layer (project membership) ────────────────────

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
  // Issue #159 U3 / U6: preference helpers.
  getUserLastProjectId: async () => null,
  setUserLastProjectId: async () => undefined,
}))

// ─── Mock the Cracker Service Layer ──────────────────────────────────
//
// We mock the service so route-level behavior (validation, error mapping,
// auth gates) is exercised without standing up a real DB. Service
// behavior is covered in crackers.test.ts.

const mockListCrackerBinaries = mock(async () => [])
const mockCreateCrackerBinary = mock(
  async (data: { engine: string; version: string; platform: string }) => ({
    id: 42,
    engine: data.engine,
    version: data.version,
    platform: data.platform,
    fileRef: {},
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
)
const mockGetCrackerBinaryById = mock(async (id: number) =>
  id === 42
    ? {
        id: 42,
        engine: 'hashcat',
        version: '6.2.6',
        platform: 'linux-x64',
        fileRef: {},
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    : null
)
const mockGetLatestCracker = mock(async () => null)
const mockGetCrackerDownloadUrl = mock(async () => null)
const mockDeleteCrackerBinary = mock(async () => 'deleted' as const)

class MockMismatch extends Error {
  constructor(
    public readonly id: number,
    public readonly attempted: string,
    public readonly stored: string
  ) {
    super(`mismatch ${id} ${attempted} vs ${stored}`)
    this.name = 'CrackerUploadIdMismatchError'
  }
}

mock.module('../../src/services/crackers.js', () => ({
  listCrackerBinaries: mockListCrackerBinaries,
  createCrackerBinary: mockCreateCrackerBinary,
  getCrackerBinaryById: mockGetCrackerBinaryById,
  updateCrackerBinary: mock(async () => null),
  deleteCrackerBinary: mockDeleteCrackerBinary,
  getLatestCracker: mockGetLatestCracker,
  getCrackerDownloadUrl: mockGetCrackerDownloadUrl,
  uploadCrackerFile: mock(async () => ({ key: 'k', size: 1 })),
  initiateCrackerChunkedUpload: mock(async () => ({ uploadId: 'u', partSize: 1024, key: 'k' })),
  uploadCrackerChunkPart: mock(async () => ({ etag: 'e' })),
  completeCrackerChunkedUpload: mock(async () => ({ id: 42 })),
  abortCrackerChunkedUpload: mock(async () => undefined),
  CrackerUploadIdMismatchError: MockMismatch,
  isUniqueViolation: (err: unknown) =>
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505',
  isKnownEngine: (engine: string) => engine === 'hashcat' || engine === 'john',
  normalizeEngineName: (engine: string | undefined | null) =>
    (engine ?? '').trim().toLowerCase() || 'hashcat',
  // mock.module is process-global in bun:test, so replacing the comparator
  // here would leak into crackers.test.ts (which exercises the real impl).
  // Re-export the real implementation imported above so both call sites stay
  // in sync automatically.
  compareCrackerVersions: realCompareCrackerVersions,
}))

// ─── Mock Required Infra ─────────────────────────────────────────────

mock.module('../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([{ id: 1, authToken: AGENT_TOKEN, status: 'online', projectId: 1 }]),
        }),
        innerJoin: () => ({ where: () => Promise.resolve([]) }),
      }),
    }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
  },
  client: {},
}))

mock.module('../../src/queue/context.js', () => ({
  getQueueManager: () => ({
    getHealth: async () => ({ status: 'connected', queues: {} }),
    init: async () => {},
    shutdown: async () => {},
  }),
  setQueueManager: () => {},
}))

mock.module('../../src/queue/manager.js', () => ({
  QueueManager: class {
    init() {
      return Promise.resolve()
    }
    shutdown() {
      return Promise.resolve()
    }
    getHealth() {
      return Promise.resolve({ status: 'connected', queues: {} })
    }
  },
}))

mock.module('../../src/config/storage.js', () => ({
  // Match the real `checkObjectStoreHealth` return shape `{status, bucket}`
  // so `probeObjectStore`'s downstream `detail.bucket` stays defined.
  checkObjectStoreHealth: async () => ({ status: 'connected', bucket: 'hashhive-test' }),
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

import { app } from '../../src/index.js'

const DASH_CRACKERS = '/api/v1/dashboard/crackers'
const AGENT_CRACKER = '/api/v1/agent/cracker/check-update'

// ─── Auth gates ──────────────────────────────────────────────────────

describe('Dashboard cracker routes: auth', () => {
  it('GET / returns 401 without session', async () => {
    const res = await app.request(DASH_CRACKERS)
    expect(res.status).toBe(401)
  })

  it('GET / returns 403 for non-admin session', async () => {
    const res = await app.request(DASH_CRACKERS, {
      headers: { cookie: VIEWER_COOKIE, 'X-Project-Id': '1' },
    })
    expect(res.status).toBe(403)
  })

  it('POST /:id/upload returns 401 without session', async () => {
    const res = await app.request(`${DASH_CRACKERS}/42/upload`, { method: 'POST' })
    expect(res.status).toBe(401)
  })
})

// ─── Validation ──────────────────────────────────────────────────────

describe('Dashboard cracker routes: validation', () => {
  it('POST / rejects unknown engine via zod enum', async () => {
    const res = await app.request(DASH_CRACKERS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: ADMIN_COOKIE, 'X-Project-Id': '1' },
      body: JSON.stringify({ engine: 'cain', version: '6.2.6', platform: 'linux-x64' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST / rejects unknown platform via zod enum', async () => {
    const res = await app.request(DASH_CRACKERS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: ADMIN_COOKIE, 'X-Project-Id': '1' },
      body: JSON.stringify({ engine: 'hashcat', version: '6.2.6', platform: 'aix-ppc' }),
    })
    expect(res.status).toBe(400)
  })

  it('GET /:id rejects non-numeric id', async () => {
    const res = await app.request(`${DASH_CRACKERS}/notanumber`, {
      headers: { cookie: ADMIN_COOKIE, 'X-Project-Id': '1' },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

// ─── Direct upload size cap ──────────────────────────────────────────

describe('Dashboard cracker routes: direct upload size cap', () => {
  it('returns 413 when Content-Length exceeds the cap', async () => {
    const res = await app.request(`${DASH_CRACKERS}/42/upload`, {
      method: 'POST',
      headers: {
        cookie: ADMIN_COOKIE,
        'X-Project-Id': '1',
        'content-length': String(200 * 1024 * 1024), // 200 MB > 100 MB cap
        'content-type': 'multipart/form-data; boundary=----test',
      },
      body: '',
    })
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })
})

// ─── Chunked upload partNumber guard ─────────────────────────────────

describe('Dashboard cracker routes: chunked upload partNumber', () => {
  it('rejects non-integer partNumber', async () => {
    const res = await app.request(`${DASH_CRACKERS}/upload/upload-id/part/1.5?crackerBinaryId=42`, {
      method: 'PUT',
      headers: {
        cookie: ADMIN_COOKIE,
        'X-Project-Id': '1',
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(res.status).toBe(400)
  })

  it('rejects partNumber above S3 max (10000)', async () => {
    const res = await app.request(
      `${DASH_CRACKERS}/upload/upload-id/part/10001?crackerBinaryId=42`,
      {
        method: 'PUT',
        headers: {
          cookie: ADMIN_COOKIE,
          'X-Project-Id': '1',
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array([1, 2, 3]),
      }
    )
    expect(res.status).toBe(400)
  })

  it('rejects partNumber below 1', async () => {
    const res = await app.request(`${DASH_CRACKERS}/upload/upload-id/part/0?crackerBinaryId=42`, {
      method: 'PUT',
      headers: {
        cookie: ADMIN_COOKIE,
        'X-Project-Id': '1',
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(res.status).toBe(400)
  })
})

// ─── Agent check-update auth + validation ────────────────────────────

describe('Agent cracker check-update', () => {
  it('returns 401 without an agent token', async () => {
    const res = await app.request(AGENT_CRACKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '6.2.6', platform: 'linux-x64' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 for missing version', async () => {
    const res = await app.request(AGENT_CRACKER, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AGENT_TOKEN}`,
      },
      body: JSON.stringify({ platform: 'linux-x64' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns updateAvailable=false for unknown engine without 4xx', async () => {
    const res = await app.request(AGENT_CRACKER, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AGENT_TOKEN}`,
      },
      body: JSON.stringify({ engine: 'cain', version: '6.2.6', platform: 'linux-x64' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { updateAvailable: boolean; engine: string }
    expect(body.updateAvailable).toBe(false)
    expect(body.engine).toBe('cain')
  })

  it('echoes normalized engine on the response', async () => {
    const res = await app.request(AGENT_CRACKER, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AGENT_TOKEN}`,
      },
      body: JSON.stringify({ engine: 'HASHCAT', version: '6.2.6', platform: 'linux-x64' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { updateAvailable: boolean; engine: string }
    expect(body.engine).toBe('hashcat')
  })
})
