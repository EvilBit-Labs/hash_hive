/**
 * Global capability-tier guard (issue #159 U5). Reads
 * `currentUser.roles` (users.roles) and gates on the admin/operator/
 * analyst vocabulary. Distinct from the per-project membership guard
 * exercised in rbac-membership.test.ts.
 */
import type { UserRole } from '@hashhive/shared'

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

import type { AppEnv } from '../../../src/types.js'

// rbac.requireRole reads c.get('currentUser') which is normally set by
// requireSession/requireApiKey upstream. For unit-level branch coverage
// we stub the upstream with a tiny pre-middleware so each test can
// control the roles array on currentUser without standing up
// BetterAuth or the API-key path.
let currentRoles: UserRole[] = []

// Stub db + auth modules so rbac.ts's imports resolve without
// reaching for a real Postgres connection.
mock.module('../../../src/db/index.js', () => ({ db: {} as never, client: {} }))
mock.module('../../../src/services/auth.js', () => ({
  findProjectMembership: async () => null,
}))

import { requireRole } from '../../../src/middleware/rbac.js'

function makeApp(...allowedRoles: UserRole[]): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('currentUser', {
      userId: 1,
      email: 'u@test.local',
      roles: currentRoles,
      projectId: null,
    })
    await next()
  })
  app.use('*', requireRole(...allowedRoles))
  app.get('/x', (c) => c.text('ok'))
  return app
}

beforeEach(() => {
  currentRoles = []
})

describe('requireRole(admin)', () => {
  const app = makeApp('admin')

  it('allows admin', async () => {
    currentRoles = ['admin']
    const res = await app.request('/x')
    expect(res.status).toBe(200)
  })

  it('rejects operator with 403 + AUTHZ_INSUFFICIENT_PERMISSIONS', async () => {
    currentRoles = ['operator']
    const res = await app.request('/x')
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body['error']['code']).toBe('AUTHZ_INSUFFICIENT_PERMISSIONS')
  })

  it('rejects analyst with 403', async () => {
    currentRoles = ['analyst']
    const res = await app.request('/x')
    expect(res.status).toBe(403)
  })

  it('rejects empty role list with 403', async () => {
    currentRoles = []
    const res = await app.request('/x')
    expect(res.status).toBe(403)
  })
})

describe('requireRole(admin, operator)', () => {
  const app = makeApp('admin', 'operator')

  it('allows admin', async () => {
    currentRoles = ['admin']
    expect((await app.request('/x')).status).toBe(200)
  })

  it('allows operator', async () => {
    currentRoles = ['operator']
    expect((await app.request('/x')).status).toBe(200)
  })

  it('rejects analyst', async () => {
    currentRoles = ['analyst']
    expect((await app.request('/x')).status).toBe(403)
  })
})

describe('requireRole(admin, operator, analyst)', () => {
  const app = makeApp('admin', 'operator', 'analyst')

  // Flat array (not 2D) so each it.each row is a scalar UserRole. With
  // a nested form like [['admin']] the static type was UserRole[] per
  // row even though Jest/bun's it.each runtime unpacks to the first
  // element -- confusing the reader and tripping copilot-pull-request-
  // reviewer's static type-check.
  it.each(['admin', 'operator', 'analyst'] as const)('allows %s', async (role) => {
    currentRoles = [role]
    expect((await app.request('/x')).status).toBe(200)
  })
})

describe('requireRole with multiple roles on the user', () => {
  it('allows when any user role intersects allowedRoles', async () => {
    currentRoles = ['analyst', 'operator']
    const app = makeApp('admin', 'operator')
    expect((await app.request('/x')).status).toBe(200)
  })

  it('rejects when no user role intersects allowedRoles', async () => {
    currentRoles = ['analyst']
    const app = makeApp('admin', 'operator')
    expect((await app.request('/x')).status).toBe(403)
  })
})
