/**
 * S-H3 regression: POST /api/v1/dashboard/projects must require the
 * global `admin` capability tier (users.roles).
 *
 * Pre-fix, any authenticated user could create a project, and
 * createProject auto-granted them project-admin on the new row -- a
 * self-elevation path from operator/analyst to admin-tier project RBAC
 * primitives.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const ADMIN_COOKIE = 'hh.session_token=admin-session'
const OPERATOR_COOKIE = 'hh.session_token=operator-session'

// ─── BetterAuth mock returns different role tiers per cookie ─────────

mock.module('../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get('cookie') ?? ''
        if (cookie.includes('admin-session')) {
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
              id: 'sess-admin',
              userId: '1',
              token: 'tok',
              expiresAt: new Date(Date.now() + 3600000),
              projectId: null,
            },
          }
        }
        if (cookie.includes('operator-session')) {
          return {
            user: {
              id: '2',
              email: 'operator@test.local',
              name: 'Operator',
              emailVerified: true,
              image: null,
              roles: ['operator'],
            },
            session: {
              id: 'sess-op',
              userId: '2',
              token: 'tok',
              expiresAt: new Date(Date.now() + 3600000),
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

mock.module('../../src/services/auth.js', () => ({
  getUserWithProjects: async () => null,
  findProjectMembership: async () => null,
  getUserLastProjectId: async () => null,
  setUserLastProjectIdIfMember: async () => 0,
  setUserLastProjectId: async () => undefined,
}))

// Default impl captured up-front so the beforeEach reset can re-apply
// it. Bun's mockReset() removes any per-test implementation overrides
// (mockResolvedValueOnce etc.) AND the default implementation, so we
// have to put the default back on every test.
const defaultCreateProjectImpl = async (input: {
  name: string
  slug: string
  createdBy: number
}) => ({
  id: 99,
  name: input.name,
  slug: input.slug,
  createdBy: input.createdBy,
  createdAt: new Date(),
  updatedAt: new Date(),
})
const mockCreateProject = mock(defaultCreateProjectImpl)

mock.module('../../src/services/projects.js', () => ({
  addUserToProject: mock(async () => undefined),
  createProject: mockCreateProject,
  getProjectById: mock(async () => null),
  getProjectMembers: mock(async () => []),
  getUserProjects: mock(async () => []),
  removeUserFromProject: mock(async () => undefined),
  updateMemberRoles: mock(async () => undefined),
  updateProject: mock(async () => null),
}))

mock.module('../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
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

const PROJECTS = '/api/v1/dashboard/projects'

describe('POST /projects: requires global admin role (S-H3)', () => {
  beforeEach(() => {
    mockCreateProject.mockReset()
    mockCreateProject.mockImplementation(defaultCreateProjectImpl)
  })

  const body = JSON.stringify({ name: 'Bravo', slug: 'bravo' })
  // Origin + Host satisfy the CSRF same-origin guard (PR review S-H4
  // follow-up). Cookie-bearing unsafe-method dashboard requests now
  // require the strict Origin check; same-origin values pass.
  const headersFor = (cookie: string) => ({
    cookie,
    'content-type': 'application/json',
    origin: 'http://lab.local',
    host: 'lab.local',
  })

  it('returns 201 for global admin', async () => {
    const res = await app.request(PROJECTS, {
      method: 'POST',
      headers: headersFor(ADMIN_COOKIE),
      body,
    })
    expect(res.status).toBe(201)
    const json = (await res.json()) as { project?: { name?: string } }
    expect(json.project?.name).toBe('Bravo')
  })

  it('returns 403 for global operator (insufficient tier)', async () => {
    const callsBefore = mockCreateProject.mock.calls.length
    const res = await app.request(PROJECTS, {
      method: 'POST',
      headers: headersFor(OPERATOR_COOKIE),
      body,
    })
    expect(res.status).toBe(403)
    const json = (await res.json()) as { error?: { code?: string } }
    expect(json.error?.code).toBe('AUTHZ_INSUFFICIENT_PERMISSIONS')
    // The service must not be invoked when the gate denies.
    expect(mockCreateProject.mock.calls.length).toBe(callsBefore)
  })

  it('returns 401 without a session cookie', async () => {
    const res = await app.request(PROJECTS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(401)
  })
})
