/**
 * `GET /me` returns `selectedProjectId` (issue #159 U6).
 *
 * The frontend (#160 selector UI) needs a single round-trip to know
 * "land on dashboard or selector"; this test pins the wire contract
 * surface so a future refactor can't silently drop the field.
 */
import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

import type { AppEnv } from '../../../src/types.js'

let mockProjectId: number | null = null
let mockGetUserWithProjects: () => Promise<unknown> = async () => null

mock.module('../../../src/db/index.js', () => ({ db: {} as never, client: {} }))

mock.module('../../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: {
          id: '7',
          email: 'admin@test',
          name: 'Admin',
          emailVerified: true,
          image: null,
          roles: ['admin'],
        },
        session: {
          id: 'sess',
          userId: '7',
          token: 'tok',
          expiresAt: new Date(Date.now() + 3600000),
          projectId: mockProjectId,
        },
      }),
    },
    handler: async () => new Response('ok'),
  },
}))

mock.module('../../../src/services/auth.js', () => ({
  getUserWithProjects: () => mockGetUserWithProjects(),
  // Other exports referenced at module load by the routes file.
  getUserApiKeyMetadata: async () => ({ hasKey: false }),
  issueUserApiKey: async () => ({ token: 'x', metadata: { hasKey: true } }),
  revokeUserApiKey: async () => undefined,
}))

import { authRoutes } from '../../../src/routes/dashboard/auth.js'

function makeApp() {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-req')
    await next()
  })
  app.route('/', authRoutes)
  return app
}

describe('GET /me selectedProjectId', () => {
  it('echoes session.projectId when a project is selected', async () => {
    mockProjectId = 42
    mockGetUserWithProjects = async () => ({
      user: { id: 7, email: 'admin@test', name: 'Admin', status: 'active', roles: ['admin'] },
      projects: [{ id: 42, name: 'P', slug: 'p', roles: ['admin'] }],
    })
    const res = await makeApp().request('/me', {
      headers: { cookie: 'hh.session_token=v' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { selectedProjectId: number | null }
    expect(body.selectedProjectId).toBe(42)
  })

  it('returns null when the session has no project selected (multi-project pre-selector)', async () => {
    mockProjectId = null
    mockGetUserWithProjects = async () => ({
      user: { id: 7, email: 'admin@test', name: 'Admin', status: 'active', roles: ['admin'] },
      projects: [
        { id: 1, name: 'P1', slug: 'p1', roles: ['admin'] },
        { id: 2, name: 'P2', slug: 'p2', roles: ['admin'] },
      ],
    })
    const res = await makeApp().request('/me', {
      headers: { cookie: 'hh.session_token=v' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { selectedProjectId: number | null }
    expect(body.selectedProjectId).toBeNull()
  })

  it('preserves the existing user + projects fields (additive change)', async () => {
    mockProjectId = 1
    mockGetUserWithProjects = async () => ({
      user: { id: 7, email: 'admin@test', name: 'Admin', status: 'active', roles: ['admin'] },
      projects: [{ id: 1, name: 'P', slug: 'p', roles: ['admin'] }],
    })
    const res = await makeApp().request('/me', {
      headers: { cookie: 'hh.session_token=v' },
    })
    const body = (await res.json()) as {
      user: { email: string; roles: string[] }
      projects: Array<{ id: number; slug: string }>
      selectedProjectId: number | null
    }
    expect(body.user.email).toBe('admin@test')
    expect(body.user.roles).toEqual(['admin'])
    expect(body.projects[0]?.slug).toBe('p')
    expect(body.selectedProjectId).toBe(1)
  })

  it('returns 404 when the user row no longer exists (RESOURCE_NOT_FOUND)', async () => {
    mockProjectId = null
    mockGetUserWithProjects = async () => null
    const res = await makeApp().request('/me', {
      headers: { cookie: 'hh.session_token=v' },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND')
  })
})
