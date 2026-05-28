/**
 * S-H4 regression: dashboard unsafe-method requests must pass a
 * same-origin Origin/Referer check.
 *
 * Mounted globally on /api/v1/dashboard/{auth,projects,agents,...}/*
 * to harden CSRF in concert with the BetterAuth session cookie's
 * SameSite=Strict attribute (lib/auth.ts).
 *
 * Headers under test:
 *  - Safe methods (GET/HEAD/OPTIONS) bypass the check entirely.
 *  - Same-origin POST/PUT/PATCH/DELETE pass.
 *  - Cross-origin Origin/Referer is rejected with 403 CSRF_ORIGIN_MISMATCH.
 *  - Dev allows http://localhost:3000 (Vite dev server).
 *
 * Exercises the middleware against the real Hono app -- the
 * dashboard mount applies it globally, so any route under the
 * gated prefixes inherits the protection.
 */
import { describe, expect, it, mock } from 'bun:test'

const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
const SAME_ORIGIN_HOST = 'lab.local'

// ─── BetterAuth: admin session ───────────────────────────────────────

mock.module('../../../src/lib/auth.js', () => ({
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

mock.module('../../../src/services/auth.js', () => ({
  getUserWithProjects: async () => ({
    id: 1,
    projects: [{ projectId: 1, roles: ['admin'] }],
  }),
  findProjectMembership: async () => ({ projectId: 1, roles: ['admin'] }),
  getUserLastProjectId: async () => null,
  setUserLastProjectIdIfMember: async () => 1,
  setUserLastProjectId: async () => undefined,
}))

mock.module('../../../src/services/projects.js', () => ({
  addUserToProject: mock(async () => undefined),
  createProject: mock(async () => null),
  getProjectById: mock(async () => null),
  getProjectMembers: mock(async () => []),
  getUserProjects: mock(async () => []),
  removeUserFromProject: mock(async () => undefined),
  updateMemberRoles: mock(async () => undefined),
  updateProject: mock(async () => null),
}))

mock.module('../../../src/db/index.js', () => ({
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

import { app } from '../../../src/index.js'

const PROJECTS = '/api/v1/dashboard/projects'

describe('requireSameOrigin: dashboard CSRF middleware (S-H4)', () => {
  it('GET / passes without Origin/Referer (safe method)', async () => {
    const res = await app.request(PROJECTS, {
      method: 'GET',
      headers: { cookie: ADMIN_COOKIE, host: SAME_ORIGIN_HOST },
    })
    // Safe method should pass the CSRF check; outcome depends on
    // downstream handler. Either 200 or some non-CSRF error is fine;
    // it must NOT be 403 CSRF_ORIGIN_MISMATCH.
    expect(res.status).not.toBe(403)
  })

  it('POST / passes when Origin matches Host (same-origin)', async () => {
    const res = await app.request(PROJECTS, {
      method: 'POST',
      headers: {
        cookie: ADMIN_COOKIE,
        host: SAME_ORIGIN_HOST,
        origin: `https://${SAME_ORIGIN_HOST}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Bravo', slug: 'bravo' }),
    })
    // 403 here would mean CSRF rejected; we expect a different status
    // (200/201/500 from the handler chain, but NOT a CSRF_ORIGIN_MISMATCH).
    expect(res.status).not.toBe(403)
  })

  it('POST / rejects with 403 CSRF_ORIGIN_MISMATCH when Origin differs from Host', async () => {
    const res = await app.request(PROJECTS, {
      method: 'POST',
      headers: {
        cookie: ADMIN_COOKIE,
        host: SAME_ORIGIN_HOST,
        origin: 'https://evil.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Bravo', slug: 'bravo' }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('CSRF_ORIGIN_MISMATCH')
  })

  it('POST / rejects when only Referer is cross-origin and Origin absent', async () => {
    const res = await app.request(PROJECTS, {
      method: 'POST',
      headers: {
        cookie: ADMIN_COOKIE,
        host: SAME_ORIGIN_HOST,
        referer: 'https://evil.example.com/x',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Bravo', slug: 'bravo' }),
    })
    expect(res.status).toBe(403)
  })

  it('POST / passes in dev when Origin is http://localhost:3000', async () => {
    // NODE_ENV is 'test' (not 'production') in this test phase, so the
    // dev-allowance branch fires.
    const res = await app.request(PROJECTS, {
      method: 'POST',
      headers: {
        cookie: ADMIN_COOKIE,
        host: SAME_ORIGIN_HOST,
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Bravo', slug: 'bravo' }),
    })
    expect(res.status).not.toBe(403)
  })
})
