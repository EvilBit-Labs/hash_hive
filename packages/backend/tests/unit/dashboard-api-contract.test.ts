/**
 * Dashboard API contract tests.
 *
 * Validates auth guards and request validation on dashboard endpoints.
 * Tests middleware layer behavior without requiring a running database.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── Mock layer ─────────────────────────────────────────────────────
//
// All module mocks are registered ONCE at module load (before
// `import { app }` below). The implementations route through mutable
// state variables so per-test overrides happen via assignment, not by
// calling `mock.module()` after the route handler has already
// captured its imports. This keeps the test stable regardless of
// import-order — the failure mode CodeRabbit flagged on the previous
// pattern (mock.module() inside it() after top-level app import).
//
// Tests that need per-case behavior reassign the impls in their setup
// and a top-level beforeEach restores defaults so leakage between
// tests is structurally prevented.

type SessionShape = {
  user: {
    id: string
    email: string
    name: string
    emailVerified: boolean
    image: string | null
    roles?: string[]
  }
  session: {
    id: string
    userId: string
    token: string
    expiresAt: Date
    projectId?: number | null
  }
} | null

const VALID_SESSION: SessionShape = {
  user: {
    id: '1',
    email: 'test@example.com',
    name: 'Test User',
    emailVerified: true,
    image: null,
    // Global capability tier (issue #159 U5).
    roles: ['admin'],
  },
  session: {
    id: 'sess-1',
    userId: '1',
    token: 'tok-1',
    expiresAt: new Date(Date.now() + 3600000),
    // Server-managed scope (issue #159 U4).
    projectId: null,
  },
}

const defaultGetSession = async ({ headers }: { headers: Headers }): Promise<SessionShape> => {
  const cookie = headers.get('cookie') ?? ''
  if (cookie.includes('hh.session_token=valid-session')) return VALID_SESSION
  return null
}

let getSessionImpl: (input: { headers: Headers }) => Promise<SessionShape> = defaultGetSession
let updateSessionImpl: (input: unknown) => Promise<unknown> = async () => ({})
let findProjectMembershipImpl: (
  userId: number,
  projectId: number
) => Promise<{ userId: number; projectId: number; roles: string[] } | null> = async () => null
let getProjectByIdImpl: (
  id: number
) => Promise<{ id: number; name: string; slug: string } | null> = async () => null

mock.module('../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: (input: { headers: Headers }) => getSessionImpl(input),
      updateSession: (input: unknown) => updateSessionImpl(input),
    },
    handler: async () => new Response('ok'),
  },
}))

mock.module('../../src/services/auth.js', () => ({
  getUserWithProjects: async () => null,
  findProjectMembership: (userId: number, projectId: number) =>
    findProjectMembershipImpl(userId, projectId),
  // Preference helpers added in #159 U6 + the membership-guarded variant
  // added during PR review feedback. The /projects/select happy path
  // invokes setUserLastProjectIdIfMember after updateSession; stub to
  // return 1 row updated (membership still holds) so the route flows
  // through the 200 success branch instead of triggering the revoked-
  // membership rollback path.
  setUserLastProjectId: async () => undefined,
  setUserLastProjectIdIfMember: async () => 1,
  getUserLastProjectId: async () => null,
}))

mock.module('../../src/services/projects.js', () => ({
  getProjectById: (id: number) => getProjectByIdImpl(id),
  // Other exports referenced at module-load by the projects route. The
  // /select endpoint doesn't use them; stub to no-ops to satisfy the
  // import surface.
  getUserProjects: async () => [],
  createProject: async () => null,
  getProjectMembers: async () => [],
  addUserToProject: async () => null,
  updateProject: async () => null,
  updateMemberRoles: async () => null,
  removeUserFromProject: async () => false,
}))

// Reset all mutable impls to their defaults before each test. Tests
// that need a specific behavior reassign in their body and rely on
// this hook to undo. No `mock.module()` re-registration ever happens
// after this file's module load.
beforeEach(() => {
  getSessionImpl = defaultGetSession
  updateSessionImpl = async () => ({})
  findProjectMembershipImpl = async () => null
  getProjectByIdImpl = async () => null
})
afterEach(() => {
  getSessionImpl = defaultGetSession
  updateSessionImpl = async () => ({})
  findProjectMembershipImpl = async () => null
  getProjectByIdImpl = async () => null
})

// Mock DB
mock.module('../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
        innerJoin: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([]),
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  },
  client: {},
}))

// Mock queue, storage, Redis
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
  createPresignedDownloadUrl: async () => 'http://localhost:9000/fake',
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

const DASH_BASE = '/api/v1/dashboard'

// ─── Auth Guards ────────────────────────────────────────────────────

describe('Dashboard API: Auth guards', () => {
  const protectedRoutes = [
    { method: 'GET', path: '/projects' },
    { method: 'POST', path: '/projects/select' },
    { method: 'GET', path: '/agents' },
    { method: 'GET', path: '/campaigns' },
    { method: 'GET', path: '/resources/hash-types' },
    { method: 'GET', path: '/tasks' },
  ]

  for (const { method, path } of protectedRoutes) {
    it(`should return 401 for ${method} ${path} without session`, async () => {
      const res = await app.request(`${DASH_BASE}${path}`, { method })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body['error']).toBeDefined()
      expect(body['error']['code']).toBe('AUTH_TOKEN_INVALID')
    })
  }
})

// ─── POST /hashes/guess-type -- Hash Type Detection ──────────────────

describe('Dashboard API: POST /hashes/guess-type', () => {
  it('should return hash type candidates for MD5', async () => {
    const res = await app.request(`${DASH_BASE}/hashes/guess-type`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'hh.session_token=valid-session',
      },
      body: JSON.stringify({ hashValue: '5d41402abc4b2a76b9719d911017c592' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body['candidates']).toBeDefined()
    expect(Array.isArray(body['candidates'])).toBe(true)
    expect(body['candidates'].length).toBeGreaterThan(0)

    const candidate = body['candidates'][0]
    expect(typeof candidate['name']).toBe('string')
    expect(typeof candidate['hashcatMode']).toBe('number')
    expect(typeof candidate['confidence']).toBe('number')
  })

  it('should return 400 for missing hashValue', async () => {
    const res = await app.request(`${DASH_BASE}/hashes/guess-type`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'hh.session_token=valid-session',
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })
})

// ─── POST /campaigns -- Create Campaign ──────────────────────────────

describe('Dashboard API: POST /campaigns', () => {
  it('should return 401 without session', async () => {
    const res = await app.request(`${DASH_BASE}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', projectId: 1, hashListId: 1, priority: 5 }),
    })
    expect(res.status).toBe(401)
  })
})

// ─── POST /projects/select -- Set session project context ────────────

describe('Dashboard API: POST /projects/select', () => {
  it('should return 400 for missing projectId', async () => {
    const res = await app.request(`${DASH_BASE}/projects/select`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'hh.session_token=valid-session',
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('should return 400 for non-integer projectId', async () => {
    const res = await app.request(`${DASH_BASE}/projects/select`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'hh.session_token=valid-session',
      },
      body: JSON.stringify({ projectId: 'abc' }),
    })
    expect(res.status).toBe(400)
  })

  it('should return 400 for unknown keys (strict schema)', async () => {
    const res = await app.request(`${DASH_BASE}/projects/select`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'hh.session_token=valid-session',
      },
      body: JSON.stringify({ projectId: 1, extra: 'nope' }),
    })
    expect(res.status).toBe(400)
  })

  it('should return 403 when user is not a member of the project', async () => {
    // Default mock for findProjectMembership returns null → 403.
    const res = await app.request(`${DASH_BASE}/projects/select`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'hh.session_token=valid-session',
      },
      body: JSON.stringify({ projectId: 42 }),
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body['error']['code']).toBe('AUTHZ_PROJECT_ACCESS_DENIED')
  })

  it('should return 403 with CSRF_ORIGIN_MISMATCH when Origin is cross-origin', async () => {
    // host on app.request is "localhost"; an Origin of evil.example
    // does not match and must be rejected before findProjectMembership
    // is consulted.
    const res = await app.request(`${DASH_BASE}/projects/select`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'hh.session_token=valid-session',
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ projectId: 42 }),
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body['error']['code']).toBe('CSRF_ORIGIN_MISMATCH')
  })

  it('should return 200 with selected project on success', async () => {
    // Per-test override via mutable impls (NOT mock.module() at runtime,
    // which doesn't take effect after the top-level `import { app }`).
    // The top-of-file beforeEach/afterEach restore defaults.
    findProjectMembershipImpl = async () => ({
      userId: 1,
      projectId: 42,
      roles: ['admin'],
    })
    getProjectByIdImpl = async (id) => ({
      id,
      name: 'Test Project',
      slug: 'test-project',
    })
    let updateSessionCalled = false
    updateSessionImpl = async () => {
      updateSessionCalled = true
      return { session: { projectId: 42 } }
    }

    const res = await app.request(`${DASH_BASE}/projects/select`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'hh.session_token=valid-session',
      },
      body: JSON.stringify({ projectId: 42 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body['project']).toBeDefined()
    expect(body['project']['id']).toBe(42)
    expect(body['project']['name']).toBe('Test Project')
    expect(updateSessionCalled).toBe(true)
  })
})

// ─── OpenAPI Sync (issue #159 U7) ──────────────────────────────────
//
// These assertions pin the dashboard-api.yaml ↔ code contract so a
// future change to either side fails loudly here. The control-api
// boundary is exercised so a stray edit doesn't accidentally remove
// X-Project-Id from the control surface (which is stateless and DOES
// rely on the header -- unlike the dashboard).
//
// Asserting against the raw YAML text (instead of parsing) keeps the
// test dependency-free; the strings checked are structural enough
// that a yaml parser would catch the same drift.

import { readFileSync } from 'node:fs'

const dashboardSpecPath = `${import.meta.dir}/../../../openapi/dashboard-api.yaml`
const controlSpecPath = `${import.meta.dir}/../../../openapi/control-api.yaml`
const dashboardYaml = readFileSync(dashboardSpecPath, 'utf8')
const controlYaml = readFileSync(controlSpecPath, 'utf8')

describe('Dashboard OpenAPI ↔ code contract (issue #159 U7)', () => {
  it('documents the /auth/me path with MeResponse schema', () => {
    expect(dashboardYaml).toMatch(/^\s+\/auth\/me:/m)
    expect(dashboardYaml).toMatch(/^\s+MeResponse:/m)
  })

  it('documents the /auth/me/api-key CRUD paths with ApiKeyMetadata schema', () => {
    expect(dashboardYaml).toMatch(/^\s+\/auth\/me\/api-key:/m)
    expect(dashboardYaml).toMatch(/^\s+ApiKeyMetadata:/m)
  })

  it('documents the /projects list + create endpoint', () => {
    expect(dashboardYaml).toMatch(/^\s+\/projects:/m)
  })

  it('documents project detail + member management paths', () => {
    expect(dashboardYaml).toMatch(/^\s+\/projects\/\{projectId\}:/m)
    expect(dashboardYaml).toMatch(/^\s+\/projects\/\{projectId\}\/members:/m)
    expect(dashboardYaml).toMatch(/^\s+\/projects\/\{projectId\}\/members\/\{userId\}:/m)
  })

  it('has zero references to XProjectIdHeader on the dashboard surface (#159 U4)', () => {
    expect(dashboardYaml).not.toContain('XProjectIdHeader')
  })

  it('control-api.yaml STILL references X-Project-Id (stateless boundary preserved)', () => {
    // The control API is per-user API keys, no session; scope MUST
    // come from the header. A regression here would silently break
    // CLI/automation clients.
    expect(controlYaml).toContain('X-Project-Id')
  })

  it('defines AuthRequired and Forbidden response shells', () => {
    expect(dashboardYaml).toMatch(/^\s+AuthRequired:/m)
    expect(dashboardYaml).toMatch(/^\s+Forbidden:/m)
  })
})
