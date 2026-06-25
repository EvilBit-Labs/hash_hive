/**
 * `POST /projects/select` persists `users.last_project_id` (issue #159 U6).
 *
 * The preference write happens AFTER the BetterAuth updateSession call
 * and is part of the request's contract -- if it fails, the response
 * returns 500 rather than silently dropping the preference. This pins
 * the call order and the failure semantics.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

import type { AppEnv } from '../../../src/types.js'

const callLog: string[] = []
let updateSessionThrows: Error | null = null
let setLastProjectIdThrows: Error | null = null
let setLastProjectIdRowsUpdated = 1

mock.module('../../../src/db/index.js', () => ({ db: {} as never, client: {} }))

mock.module('../../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: {
          id: '1',
          email: 'u@test',
          name: 'U',
          emailVerified: true,
          image: null,
          roles: ['admin'],
        },
        session: {
          id: 's',
          userId: '1',
          token: 't',
          expiresAt: new Date(Date.now() + 3600000),
          projectId: null,
        },
      }),
      updateSession: async () => {
        callLog.push('updateSession')
        if (updateSessionThrows) throw updateSessionThrows
        return {}
      },
    },
    handler: async () => new Response('ok'),
  },
}))

mock.module('../../../src/services/auth.js', () => ({
  findProjectMembership: async (_userId: number, projectId: number) =>
    projectId === 1 ? { id: 1, userId: 1, projectId: 1, roles: ['admin'] } : null,
  setUserLastProjectIdIfMember: async (_userId: number, _projectId: number) => {
    callLog.push('setUserLastProjectIdIfMember')
    if (setLastProjectIdThrows) throw setLastProjectIdThrows
    return setLastProjectIdRowsUpdated
  },
  // Other exports referenced at module load.
  setUserLastProjectId: async () => undefined,
  getUserWithProjects: async () => null,
  getUserLastProjectId: async () => null,
  getUserApiKeyMetadata: async () => ({ hasKey: false }),
  issueUserApiKey: async () => ({ token: 'x', metadata: { hasKey: true } }),
  revokeUserApiKey: async () => undefined,
}))

mock.module('../../../src/services/projects.js', () => ({
  getProjectById: async (id: number) =>
    id === 1 ? { id: 1, name: 'P1', slug: 'p1', settings: {}, createdBy: null } : null,
  getUserProjects: async () => [],
  createProject: async () => null,
  findUserProjectById: async () => null,
  getUserProjectsPaginated: async () => ({ items: [], total: 0 }),
  getProjectMembers: async () => [],
  addUserToProject: async () => null,
  updateProject: async () => null,
  updateMemberRoles: async () => null,
  removeUserFromProject: async () => false,
}))

import { projectRoutes } from '../../../src/routes/dashboard/projects.js'

function makeApp() {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-req')
    await next()
  })
  app.route('/', projectRoutes)
  return app
}

beforeEach(() => {
  callLog.length = 0
  updateSessionThrows = null
  setLastProjectIdThrows = null
  setLastProjectIdRowsUpdated = 1
})

describe('POST /select persists users.last_project_id', () => {
  it('calls updateSession FIRST, then setUserLastProjectIdIfMember (order matters)', async () => {
    const res = await makeApp().request('/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'hh.session_token=v' },
      body: JSON.stringify({ projectId: 1 }),
    })
    expect(res.status).toBe(200)
    expect(callLog).toEqual(['updateSession', 'setUserLastProjectIdIfMember'])
  })

  it('returns 500 INTERNAL_ERROR when the preference write fails', async () => {
    setLastProjectIdThrows = new Error('db down')
    const res = await makeApp().request('/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'hh.session_token=v' },
      body: JSON.stringify({ projectId: 1 }),
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(body.error.message).toContain('last project preference')
    // updateSession ran (session is already updated); setUserLastProjectIdIfMember
    // was attempted but threw.
    expect(callLog).toEqual(['updateSession', 'setUserLastProjectIdIfMember'])
  })

  it('does NOT call setUserLastProjectIdIfMember if updateSession itself fails', async () => {
    updateSessionThrows = new Error('better-auth down')
    const res = await makeApp().request('/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'hh.session_token=v' },
      body: JSON.stringify({ projectId: 1 }),
    })
    expect(res.status).toBe(500)
    expect(callLog).toEqual(['updateSession'])
  })

  it('does NOT call setUserLastProjectIdIfMember when membership check fails (403)', async () => {
    const res = await makeApp().request('/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'hh.session_token=v' },
      body: JSON.stringify({ projectId: 999 }), // not a member
    })
    expect(res.status).toBe(403)
    expect(callLog).toEqual([])
  })

  it('rolls back session.projectId to null and returns 403 when membership was revoked mid-request', async () => {
    // setUserLastProjectIdIfMember returns 0 rows updated -- meaning
    // an admin removed the user between findProjectMembership above
    // and the guarded UPDATE. Handler must clear the session scope
    // back to null and surface AUTHZ_PROJECT_ACCESS_DENIED.
    setLastProjectIdRowsUpdated = 0
    const res = await makeApp().request('/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'hh.session_token=v' },
      body: JSON.stringify({ projectId: 1 }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('AUTHZ_PROJECT_ACCESS_DENIED')
    // updateSession was called TWICE: once to set projectId=1, once to
    // roll it back to null.
    expect(callLog).toEqual(['updateSession', 'setUserLastProjectIdIfMember', 'updateSession'])
  })
})
