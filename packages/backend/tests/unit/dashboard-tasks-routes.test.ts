/**
 * Dashboard tasks route contract tests.
 *
 * Regression coverage for S-H1: pre-fix, the dashboard tasks routes
 * delegated to `listTasks` / `getTaskById` without any project predicate,
 * so a caller with `requireProjectAccess()` membership in *any* project
 * could enumerate every task across every project. The service-level
 * fix makes `projectId` a required filter; these tests assert the route
 * forwards `currentUser.projectId` correctly and that tasks in foreign
 * projects are not returned.
 */
import { describe, expect, it, mock } from 'bun:test'

const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'

// ─── Mock BetterAuth ─────────────────────────────────────────────────

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
        return null
      },
    },
    handler: async () => new Response('ok'),
  },
}))

// ─── Mock Auth Service Layer ─────────────────────────────────────────

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
  getUserLastProjectId: async () => null,
  setUserLastProjectIdIfMember: async () => 1,
  setUserLastProjectId: async () => undefined,
}))

// ─── Mock Tasks Service Layer ────────────────────────────────────────
//
// The mocks capture the `projectId` argument so the tests can assert
// the route correctly forwarded the session-scoped project.

const mockListTasks = mock(async (filters: { projectId: number }) => ({
  tasks: filters.projectId === 1 ? [{ id: 42, campaignId: 7, status: 'pending' }] : [],
  total: filters.projectId === 1 ? 1 : 0,
  limit: 50,
  offset: 0,
}))

const mockGetTaskById = mock(async (id: number, projectId: number) => {
  // Task 100 lives in project 1; task 200 lives in project 999 (foreign).
  if (id === 100 && projectId === 1) {
    return { id: 100, campaignId: 7, status: 'pending', projectId: 1 }
  }
  return null
})

mock.module('../../src/services/tasks.js', () => ({
  listTasks: mockListTasks,
  getTaskById: mockGetTaskById,
}))

// ─── Resolvable downstream mocks (route module graph needs them) ─────

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

const DASH_TASKS = '/api/v1/dashboard/tasks'

describe('Dashboard tasks routes: project isolation (S-H1)', () => {
  it('GET / forwards currentUser.projectId to listTasks', async () => {
    const res = await app.request(`${DASH_TASKS}`, {
      headers: { cookie: ADMIN_COOKIE },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tasks: unknown[]; total: number }
    expect(body.total).toBe(1)
    expect(body.tasks.length).toBe(1)
    // Critically: the call to listTasks must have included projectId
    const lastCall = mockListTasks.mock.calls[mockListTasks.mock.calls.length - 1]
    expect(lastCall).toBeDefined()
    expect(lastCall?.[0].projectId).toBe(1)
  })

  it('GET /:id returns 200 for task in active project', async () => {
    const res = await app.request(`${DASH_TASKS}/100`, {
      headers: { cookie: ADMIN_COOKIE },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task?: { id?: number } }
    expect(body.task?.id).toBe(100)
  })

  it('GET /:id returns 404 for task in foreign project (service returns null)', async () => {
    // Mock returns null for id=200 because projectId predicate doesn't match.
    const res = await app.request(`${DASH_TASKS}/200`, {
      headers: { cookie: ADMIN_COOKIE },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
    // getTaskById must have been called with projectId=1
    const lastCall = mockGetTaskById.mock.calls[mockGetTaskById.mock.calls.length - 1]
    expect(lastCall).toBeDefined()
    expect(lastCall?.[1]).toBe(1)
  })

  it('GET / returns 401 without a session cookie', async () => {
    const res = await app.request(`${DASH_TASKS}`)
    expect(res.status).toBe(401)
  })
})
