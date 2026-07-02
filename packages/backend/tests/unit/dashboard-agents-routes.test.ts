/**
 * Dashboard agents route contract tests.
 *
 * Validates auth and project-isolation gates for the dashboard agents
 * routes — in particular the cross-project boundary on the new
 * `/agents/:id/tasks` endpoint, which is a security-relevant path the
 * service-level review flagged as needing explicit coverage.
 */
import { describe, expect, it, mock } from 'bun:test'

// ─── Mock BetterAuth ─────────────────────────────────────────────────

const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
// Retire is admin-only (issue #106 U9) — a contributor session proves the
// route rejects the role that the archive/restore surfaces (which allow
// admin+contributor) would accept.
const CONTRIBUTOR_COOKIE = 'hh.session_token=valid-contributor-session'

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
              // Global capability tier (users.roles) -- read by the
              // new global requireRole guard from issue #159 U5.
              roles: ['admin'],
            },
            session: {
              id: 'sess',
              userId: '1',
              token: 'tok',
              expiresAt: new Date(Date.now() + 3600000),
              // Server-managed scope -- after issue #159 U4 the
              // dashboard ignores X-Project-Id and reads this instead.
              projectId: 1,
            },
          }
        }
        if (cookie.includes('valid-contributor-session')) {
          return {
            user: {
              id: '3',
              email: 'contributor@test.local',
              name: 'Contributor',
              emailVerified: true,
              image: null,
              roles: [],
            },
            session: {
              id: 'sess-contributor',
              userId: '3',
              token: 'tok-contributor',
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

// ─── Mock Auth Service Layer (project membership) ────────────────────

mock.module('../../src/services/auth.js', () => ({
  getUserWithProjects: async (userId: number) => {
    if (userId === 1) {
      return { id: 1, projects: [{ projectId: 1, roles: ['admin'] }] }
    }
    if (userId === 3) {
      return { id: 3, projects: [{ projectId: 1, roles: ['contributor'] }] }
    }
    return null
  },
  findProjectMembership: async (userId: number, projectId: number) => {
    if (projectId !== 1) return null
    if (userId === 1) return { projectId: 1, roles: ['admin'] }
    if (userId === 3) return { projectId: 1, roles: ['contributor'] }
    return null
  },
  // Issue #159 U3 / U6: preference helpers.
  getUserLastProjectId: async () => null,
  setUserLastProjectIdIfMember: async () => 1,
  setUserLastProjectId: async () => undefined,
}))

// ─── Mock the Agents Service Layer ───────────────────────────────────
//
// Per the contract-test-mocks-mirror-service-not-schema convention:
// type the mock factories via `typeof svc` and derive the row shape
// from the real service so a signature drift surfaces as a type-check
// failure. A `makeAgent` builder fills the partial fixtures used by
// tests with the full Drizzle row (operatingSystemId, authTokenHash,
// authTokenFormat) so the mocks satisfy the real return type.

type AgentsService = typeof import('../../src/services/agents.js')
type TasksService = typeof import('../../src/services/tasks.js')
type AgentRow = NonNullable<Awaited<ReturnType<AgentsService['getAgentById']>>>

// Defaults come first so `??` falls through to safe values; the
// trailing-spread footgun is avoided by enumerating every field
// explicitly. Callers can still set any field via `p` (including
// id/projectId from the Pick) and the `??` fallback covers absent
// keys. Setting a field to `undefined` explicitly still hits the
// default — that's the intended invariant.
function makeAgent(p: Partial<AgentRow> & Pick<AgentRow, 'id' | 'projectId'>): AgentRow {
  return {
    id: p.id,
    projectId: p.projectId,
    name: p.name ?? `Agent ${p.id}`,
    status: p.status ?? 'online',
    operatingSystemId: p.operatingSystemId ?? null,
    authToken: p.authToken ?? 'tok',
    authTokenHash: p.authTokenHash ?? null,
    authTokenFormat: p.authTokenFormat ?? 'plaintext',
    capabilities: p.capabilities ?? {},
    hardwareProfile: p.hardwareProfile ?? {},
    crackerVersion: p.crackerVersion ?? null,
    lastSeenAt: p.lastSeenAt ?? new Date(),
    createdAt: p.createdAt ?? new Date(),
    updatedAt: p.updatedAt ?? new Date(),
  }
}

const mockGetAgentById: AgentsService['getAgentById'] = mock(async (id: number) => {
  if (id === 100) return makeAgent({ id: 100, projectId: 1, name: 'Rig Alpha' })
  if (id === 200) return makeAgent({ id: 200, projectId: 999, name: 'Rig Beta' })
  return null
})

const mockUpdateAgent: AgentsService['updateAgent'] = mock(async (id, patch, projectId) => {
  // Honors the atomic UPDATE WHERE projectId contract: id=100 lives
  // in project 1, id=200 lives in project 999 (foreign). A mismatch
  // collapses to not_found exactly the way the real query would after
  // the 0 rows-affected. Mirrors the real service's typed-outcome
  // contract (issue #106 F4).
  if (id === 100 && projectId === 1) {
    return {
      kind: 'updated' as const,
      agent: makeAgent({
        id: 100,
        projectId: 1,
        name: patch.name ?? 'Rig Alpha',
        status: patch.status ?? 'online',
      }),
    }
  }
  return { kind: 'not_found' as const }
})

const mockRotateAgentToken: AgentsService['rotateAgentToken'] = mock(async (agentId, projectId) => {
  // Mirrors the real service: same-project rotation succeeds and
  // returns the raw token once; cross-project hands back null so the
  // route maps to 404.
  if (agentId === 100 && projectId === 1) {
    return { token: 'agt_100_test-rotated-token' }
  }
  return null
})

// Mirrors the real service's typed-outcome contract (issue #106 U8): id=100
// in project 1 retires successfully and releases two in-flight tasks; any
// other (id, projectId) pair — including the cross-project id=200 case —
// reports not_found the same way the real project-scoped pre-check would.
const mockRetireAgent: AgentsService['retireAgent'] = mock(async (agentId, projectId) => {
  if (agentId === 100 && projectId === 1) {
    return { kind: 'retired' as const, agentId: 100, releasedTaskIds: [501, 502] }
  }
  return { kind: 'not_found' as const }
})

mock.module('../../src/services/agents.js', () => ({
  getAgentById: mockGetAgentById,
  getAgentErrors: mock(
    async () => [] satisfies Awaited<ReturnType<AgentsService['getAgentErrors']>>
  ),
  getBenchmarksForAgent: mock(
    async () => [] satisfies Awaited<ReturnType<AgentsService['getBenchmarksForAgent']>>
  ),
  listAgents: mock(
    async () =>
      ({
        agents: [],
        total: 0,
        limit: 50,
        offset: 0,
      }) satisfies Awaited<ReturnType<AgentsService['listAgents']>>
  ),
  rotateAgentToken: mockRotateAgentToken,
  retireAgent: mockRetireAgent,
  updateAgent: mockUpdateAgent,
}))

mock.module('../../src/services/tasks.js', () => ({
  listTasksByAgent: mock(
    async () =>
      [
        {
          id: 1,
          campaignId: 1,
          campaignName: 'Test Campaign',
          attackId: 1,
          attackMode: 0,
          status: 'running',
          progress: {},
          startedAt: null,
          assignedAt: null,
        },
      ] satisfies Awaited<ReturnType<TasksService['listTasksByAgent']>>
  ),
}))

// ─── Mock DB / Storage / Redis (route handlers don't reach these, but
// the module graph wants them resolvable) ─────────────────────────────

mock.module('../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
        innerJoin: () => ({ where: () => Promise.resolve([]) }),
      }),
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

import { app } from '../../src/index.js'

const DASH_AGENTS = '/api/v1/dashboard/agents'

describe('Dashboard agents routes: project isolation', () => {
  it('GET /:id/tasks returns 404 when agent belongs to a different project', async () => {
    const res = await app.request(`${DASH_AGENTS}/200/tasks`, {
      headers: {
        cookie: ADMIN_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
        'x-project-id': '1',
      },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
  })

  it('GET /:id/tasks returns 200 for an agent in the active project', async () => {
    const res = await app.request(`${DASH_AGENTS}/100/tasks`, {
      headers: {
        cookie: ADMIN_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
        'x-project-id': '1',
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tasks: unknown[] }
    expect(Array.isArray(body.tasks)).toBe(true)
    expect(body.tasks.length).toBe(1)
  })

  it('GET /:id/tasks returns 400 for a non-numeric id', async () => {
    const res = await app.request(`${DASH_AGENTS}/not-a-number/tasks`, {
      headers: {
        cookie: ADMIN_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
        'x-project-id': '1',
      },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('VALIDATION_ERROR')
  })

  it('GET /:id/tasks returns 404 when the agent does not exist', async () => {
    const res = await app.request(`${DASH_AGENTS}/9999/tasks`, {
      headers: {
        cookie: ADMIN_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
        'x-project-id': '1',
      },
    })
    expect(res.status).toBe(404)
  })

  it('GET /:id/tasks returns 401 without a session cookie', async () => {
    const res = await app.request(`${DASH_AGENTS}/100/tasks`)
    expect(res.status).toBe(401)
  })

  // Regression: S-C1 (cross-project horizontal privilege escalation).
  // Pre-fix, PATCH /:id had no projectId check; a contributor in any project
  // could rename or force-offline any agent system-wide.
  it('PATCH /:id returns 404 when target agent belongs to a different project', async () => {
    const res = await app.request(`${DASH_AGENTS}/200`, {
      method: 'PATCH',
      headers: {
        cookie: ADMIN_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'offline' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
    // Post-F3 the cross-project guard is the atomic UPDATE WHERE
    // projectId inside the service; the route calls updateAgent with
    // the session's projectId and the SQL returns 0 rows for any
    // cross-project agent. So updateAgent SHOULD have been called
    // (with projectId=1), and the mock returns null because 200 lives
    // in project 999.
    const crossProjectCalls = mockUpdateAgent.mock.calls.filter(
      ([id, , projectId]) => id === 200 && projectId === 1
    )
    expect(crossProjectCalls.length).toBe(1)
  })

  it('PATCH /:id returns 200 for an agent in the active project', async () => {
    const res = await app.request(`${DASH_AGENTS}/100`, {
      method: 'PATCH',
      headers: {
        cookie: ADMIN_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Renamed Rig' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { agent?: { name?: string } }
    expect(body.agent?.name).toBe('Renamed Rig')
  })

  it('PATCH /:id returns 404 when the agent does not exist', async () => {
    const res = await app.request(`${DASH_AGENTS}/9999`, {
      method: 'PATCH',
      headers: {
        cookie: ADMIN_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'offline' }),
    })
    expect(res.status).toBe(404)
  })
})

// S-H2: POST /agents/:id/rotate-token contract.
describe('Dashboard agents routes: token rotation', () => {
  it('POST /:id/rotate-token returns the raw token exactly once for an admin', async () => {
    const res = await app.request(`${DASH_AGENTS}/100/rotate-token`, {
      method: 'POST',
      headers: {
        cookie: ADMIN_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token?: string }
    expect(body.token).toBe('agt_100_test-rotated-token')
  })

  it('POST /:id/rotate-token sets Cache-Control: no-store on the response', async () => {
    const res = await app.request(`${DASH_AGENTS}/100/rotate-token`, {
      method: 'POST',
      headers: {
        cookie: ADMIN_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
      },
    })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('POST /:id/rotate-token returns 404 for a cross-project agent', async () => {
    const res = await app.request(`${DASH_AGENTS}/200/rotate-token`, {
      method: 'POST',
      headers: {
        cookie: ADMIN_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
      },
    })
    expect(res.status).toBe(404)
  })

  it('POST /:id/rotate-token returns 401 without a session cookie', async () => {
    const res = await app.request(`${DASH_AGENTS}/100/rotate-token`, {
      method: 'POST',
      headers: {
        origin: 'http://lab.local',
        host: 'lab.local',
      },
    })
    expect(res.status).toBe(401)
  })
})

// Issue #106 U8/U9: POST /agents/:id/retire contract.
describe('Dashboard agents routes: retire', () => {
  it('POST /:id/retire flips status and returns the outcome for an admin', async () => {
    mockRetireAgent.mockClear()
    const res = await app.request(`${DASH_AGENTS}/100/retire`, {
      method: 'POST',
      headers: {
        cookie: ADMIN_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { outcome?: string; releasedTaskIds?: number[] }
    expect(body.outcome).toBe('retired')
    expect(body.releasedTaskIds).toEqual([501, 502])
    expect(mockRetireAgent).toHaveBeenCalledWith(100, 1, { actorType: 'user', actorId: 1 })
  })

  it('POST /:id/retire returns 404 for a cross-project agent', async () => {
    const res = await app.request(`${DASH_AGENTS}/200/retire`, {
      method: 'POST',
      headers: {
        cookie: ADMIN_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
      },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
  })

  it('POST /:id/retire returns 403 for a contributor (admin-only, unlike archive/restore)', async () => {
    const res = await app.request(`${DASH_AGENTS}/100/retire`, {
      method: 'POST',
      headers: {
        cookie: CONTRIBUTOR_COOKIE,
        origin: 'http://lab.local',
        host: 'lab.local',
      },
    })
    expect(res.status).toBe(403)
  })

  it('POST /:id/retire returns 401 without a session cookie', async () => {
    const res = await app.request(`${DASH_AGENTS}/100/retire`, {
      method: 'POST',
      headers: {
        origin: 'http://lab.local',
        host: 'lab.local',
      },
    })
    expect(res.status).toBe(401)
  })
})
