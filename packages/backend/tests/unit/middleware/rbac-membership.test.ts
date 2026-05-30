/**
 * Per-project membership guard (issue #159 U5). Was named `requireRole`
 * pre-#159; renamed to `requireMembershipRole` so the two RBAC layers
 * stay visually distinct in route files. Behavior unchanged from the
 * pre-rename version.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

import type { AppEnv } from '../../../src/types.js'

let mockMembership: { id: number; userId: number; projectId: number; roles: string[] } | null = null
const findProjectMembershipMock = mock(async () => mockMembership)

mock.module('../../../src/db/index.js', () => ({ db: {} as never, client: {} }))
mock.module('../../../src/services/auth.js', () => ({
  findProjectMembership: findProjectMembershipMock,
}))

import { requireMembershipRole, requireProjectAccess } from '../../../src/middleware/rbac.js'

type CurrentUser = AppEnv['Variables']['currentUser']

function makeApp(allowedRoles: Parameters<typeof requireMembershipRole>, user: CurrentUser) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('currentUser', user)
    await next()
  })
  app.use('*', requireMembershipRole(...allowedRoles))
  app.get('/x', (c) => c.text('ok'))
  return app
}

const baseUser: CurrentUser = {
  userId: 1,
  email: 'u@test',
  roles: ['admin'],
  projectId: 1,
}

beforeEach(() => {
  mockMembership = null
  // mockReset() clears history AND removes any per-test implementation
  // overrides (mockResolvedValueOnce etc.) -- mockClear() preserves the
  // overrides and would leak them into subsequent tests. Bun's mockReset
  // ALSO removes the default implementation, so we re-establish it here
  // pointing at the mutable `mockMembership` binding. This is the
  // recommended pattern per the bun:test docs:
  // https://bun.com/docs/test/mocks
  findProjectMembershipMock.mockReset()
  findProjectMembershipMock.mockImplementation(async () => mockMembership)
})

describe('requireMembershipRole', () => {
  it('returns 400 PROJECT_NOT_SELECTED when currentUser.projectId is null', async () => {
    const app = makeApp(['admin'], { ...baseUser, projectId: null })
    const res = await app.request('/x')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body['error']['code']).toBe('PROJECT_NOT_SELECTED')
  })

  it('returns 403 AUTHZ_PROJECT_ACCESS_DENIED when no membership row exists', async () => {
    mockMembership = null
    const app = makeApp(['admin'], baseUser)
    const res = await app.request('/x')
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body['error']['code']).toBe('AUTHZ_PROJECT_ACCESS_DENIED')
  })

  it("allows when membership.roles intersects the request's allowedRoles", async () => {
    mockMembership = { id: 1, userId: 1, projectId: 1, roles: ['admin'] }
    const app = makeApp(['admin'], baseUser)
    const res = await app.request('/x')
    expect(res.status).toBe(200)
  })

  it('allows when ANY of the requested roles intersects', async () => {
    mockMembership = { id: 1, userId: 1, projectId: 1, roles: ['contributor'] }
    const app = makeApp(['admin', 'contributor'], baseUser)
    expect((await app.request('/x')).status).toBe(200)
  })

  it('rejects when membership exists but roles do not intersect (403 INSUFFICIENT_PERMISSIONS)', async () => {
    mockMembership = { id: 1, userId: 1, projectId: 1, roles: ['viewer'] }
    const app = makeApp(['admin'], baseUser)
    const res = await app.request('/x')
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body['error']['code']).toBe('AUTHZ_INSUFFICIENT_PERMISSIONS')
  })
})

// P-C1 regression: per-request membership cache.
describe('per-request membership cache (P-C1)', () => {
  it('hits findProjectMembership exactly once when both requireProjectAccess + requireMembershipRole are stacked', async () => {
    mockMembership = { id: 1, userId: 1, projectId: 1, roles: ['admin'] }
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('currentUser', baseUser)
      await next()
    })
    app.use('*', requireProjectAccess())
    app.use('*', requireMembershipRole('admin'))
    app.get('/x', (c) => c.text('ok'))

    const res = await app.request('/x')
    expect(res.status).toBe(200)
    expect(findProjectMembershipMock.mock.calls.length).toBe(1)
  })

  it('does NOT leak the cached membership across separate requests', async () => {
    mockMembership = { id: 1, userId: 1, projectId: 1, roles: ['admin'] }
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('currentUser', baseUser)
      await next()
    })
    app.use('*', requireMembershipRole('admin'))
    app.get('/x', (c) => c.text('ok'))

    await app.request('/x')
    await app.request('/x')
    // Two separate requests => two separate cache scopes => two DB hits.
    expect(findProjectMembershipMock.mock.calls.length).toBe(2)
  })
})

// CQ-H3 regression: scopedUser is populated after the middleware runs.
describe('scopedUser context variable (CQ-H3)', () => {
  it('populates scopedUser with non-null projectId after requireProjectAccess', async () => {
    mockMembership = { id: 1, userId: 1, projectId: 1, roles: ['admin'] }
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('currentUser', baseUser)
      await next()
    })
    app.use('*', requireProjectAccess())
    app.get('/x', (c) => {
      const su = c.get('scopedUser')
      return c.json({ scopedUser: su })
    })

    const res = await app.request('/x')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      scopedUser: { userId: number; projectId: number; roles: string[] }
    }
    expect(body.scopedUser.userId).toBe(1)
    expect(body.scopedUser.projectId).toBe(1)
    expect(body.scopedUser.roles).toEqual(['admin'])
  })

  it('populates scopedUser after requireMembershipRole as well', async () => {
    mockMembership = { id: 1, userId: 1, projectId: 1, roles: ['contributor'] }
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('currentUser', baseUser)
      await next()
    })
    app.use('*', requireMembershipRole('admin', 'contributor'))
    app.get('/x', (c) => {
      const su = c.get('scopedUser')
      return c.json({ projectId: su?.projectId, roles: su?.roles })
    })

    const res = await app.request('/x')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projectId: number; roles: string[] }
    expect(body.projectId).toBe(1)
    expect(body.roles).toEqual(['contributor'])
  })
})
