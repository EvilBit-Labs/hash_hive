/**
 * #233 / #114 U5 — dashboard enrollment-token route contract tests.
 *
 * Validates the admin-only, project-scoped create / list / revoke routes:
 * RBAC (admin required for create + revoke; member for list), the
 * once-only raw token + `Cache-Control: no-store` on create, future-expiry
 * validation, list never leaking the secret, and the 404 on a missing /
 * cross-project token.
 *
 * Runs in an isolated bun:test phase (DASHBOARD_ENROLLMENT_TEST_ISOLATED=1)
 * because the `mock.module` calls (auth, enrollment service, db, ioredis)
 * are process-global; mirrors the other isolated dashboard-route suites
 * (dashboard-campaigns / dashboard-resources / dashboard-results).
 *
 * Service mocks are pinned to the real service ReturnType per
 * docs/solutions/conventions/contract-test-mocks-mirror-service-not-schema.md.
 */
import { OpenAPIHono } from '@hono/zod-openapi'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['DASHBOARD_ENROLLMENT_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('dashboard-enrollment-tokens-routes (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-enrollment-tokens-routes] skipped — set DASHBOARD_ENROLLMENT_TEST_ISOLATED=1 to run; the suite did NOT execute in this phase.'
      )
      expect(process.env['DASHBOARD_ENROLLMENT_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
  const VIEWER_COOKIE = 'hh.session_token=valid-viewer-session'
  const ORIGIN_HEADERS = { origin: 'http://lab.local', host: 'lab.local' }

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
                id: 'sa',
                userId: '1',
                token: 't',
                expiresAt: new Date(Date.now() + 3_600_000),
                projectId: 1,
              },
            }
          }
          if (cookie.includes('valid-viewer-session')) {
            return {
              user: {
                id: '2',
                email: 'viewer@test.local',
                name: 'Viewer',
                emailVerified: true,
                image: null,
                roles: ['analyst'],
              },
              session: {
                id: 'sv',
                userId: '2',
                token: 't',
                expiresAt: new Date(Date.now() + 3_600_000),
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

  mock.module('../../src/services/auth.js', () => ({
    getUserWithProjects: async (userId: number) =>
      userId === 1
        ? { id: 1, projects: [{ projectId: 1, roles: ['admin'] }] }
        : userId === 2
          ? { id: 2, projects: [{ projectId: 1, roles: ['viewer'] }] }
          : null,
    findProjectMembership: async (userId: number, projectId: number) => {
      if (projectId !== 1) return null
      if (userId === 1) return { projectId: 1, roles: ['admin'] }
      if (userId === 2) return { projectId: 1, roles: ['viewer'] }
      return null
    },
    getUserLastProjectId: async () => null,
    setUserLastProjectIdIfMember: async () => 1,
    setUserLastProjectId: async () => undefined,
  }))

  type EnrollSvc = typeof import('../../src/services/enrollment-tokens.js')
  const META = {
    id: 1,
    projectId: 1,
    label: 'rack-3 rigs',
    isReusable: true,
    maxUses: 3,
    useCount: 0,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: '2026-06-18T00:00:00.000Z',
  } satisfies Awaited<ReturnType<EnrollSvc['listEnrollmentTokens']>>[number]

  const createMock: EnrollSvc['createEnrollmentToken'] = mock(
    async () =>
      ({ token: 'etk_1_brave-coral-otter-47', metadata: META }) satisfies Awaited<
        ReturnType<EnrollSvc['createEnrollmentToken']>
      >
  )
  const listMock: EnrollSvc['listEnrollmentTokens'] = mock(
    async () => [META] satisfies Awaited<ReturnType<EnrollSvc['listEnrollmentTokens']>>
  )
  const revokeMock: EnrollSvc['revokeEnrollmentToken'] = mock(async (id: number) =>
    id === 1
      ? ({ ...META, revokedAt: '2026-06-18T01:00:00.000Z' } satisfies Awaited<
          ReturnType<EnrollSvc['revokeEnrollmentToken']>
        >)
      : null
  )

  mock.module('../../src/services/enrollment-tokens.js', () => ({
    createEnrollmentToken: createMock,
    listEnrollmentTokens: listMock,
    revokeEnrollmentToken: revokeMock,
    // The agent route imports this from the same module; mock.module
    // replaces the whole module, so it must be exported here too (unused
    // in these tests).
    claimEnrollmentToken: mock(async () => ({ ok: false, reason: 'invalid' as const })),
  }))

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    },
    client: {},
  }))

  // Mount only the enrollment-tokens router (not the full app) so the
  // import graph stays small: its middleware needs just lib/auth `auth`
  // and services/auth `findProjectMembership`, both mocked above.
  const { enrollmentTokenRoutes } = await import('../../src/routes/dashboard/enrollment-tokens.js')
  const app = new OpenAPIHono()
  app.route('/api/v1/dashboard/enrollment-tokens', enrollmentTokenRoutes)
  const BASE = '/api/v1/dashboard/enrollment-tokens'

  beforeEach(() => {
    createMock.mockClear()
    listMock.mockClear()
    revokeMock.mockClear()
  })

  describe('POST / (mint)', () => {
    it('mints a token for an admin and returns it once with no-store', async () => {
      const res = await app.request(BASE, {
        method: 'POST',
        headers: { cookie: ADMIN_COOKIE, 'content-type': 'application/json', ...ORIGIN_HEADERS },
        body: JSON.stringify({ label: 'rack-3 rigs', isReusable: true, maxUses: 3 }),
      })
      expect(res.status).toBe(201)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const body = (await res.json()) as { token: string; metadata: Record<string, unknown> }
      expect(body.token).toBe('etk_1_brave-coral-otter-47')
      expect(body.metadata).not.toHaveProperty('secretHash')
    })

    it('rejects a non-admin member with 403', async () => {
      const res = await app.request(BASE, {
        method: 'POST',
        headers: { cookie: VIEWER_COOKIE, 'content-type': 'application/json', ...ORIGIN_HEADERS },
        body: JSON.stringify({ isReusable: false }),
      })
      expect(res.status).toBe(403)
      expect(createMock).not.toHaveBeenCalled()
    })

    it('rejects an unauthenticated request with 401', async () => {
      const res = await app.request(BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ORIGIN_HEADERS },
        body: JSON.stringify({ isReusable: false }),
      })
      expect(res.status).toBe(401)
    })

    it('rejects a past expiry with 422', async () => {
      const res = await app.request(BASE, {
        method: 'POST',
        headers: { cookie: ADMIN_COOKIE, 'content-type': 'application/json', ...ORIGIN_HEADERS },
        body: JSON.stringify({ isReusable: false, expiresAt: '2020-01-01T00:00:00.000Z' }),
      })
      expect(res.status).toBe(422)
    })
  })

  describe('GET / (list)', () => {
    it('returns metadata for a member, never the secret hash', async () => {
      const res = await app.request(BASE, { headers: { cookie: ADMIN_COOKIE, ...ORIGIN_HEADERS } })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { tokens: Record<string, unknown>[] }
      expect(body.tokens).toHaveLength(1)
      expect(body.tokens[0]).not.toHaveProperty('secretHash')
    })

    it('rejects an unauthenticated request with 401', async () => {
      const res = await app.request(BASE, { headers: { ...ORIGIN_HEADERS } })
      expect(res.status).toBe(401)
    })
  })

  describe('DELETE /{id} (revoke)', () => {
    it('revokes for an admin and returns the final metadata', async () => {
      const res = await app.request(`${BASE}/1`, {
        method: 'DELETE',
        headers: { cookie: ADMIN_COOKIE, ...ORIGIN_HEADERS },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { revokedAt: string | null }
      expect(body.revokedAt).toBe('2026-06-18T01:00:00.000Z')
    })

    it('returns 404 for a missing / cross-project token', async () => {
      const res = await app.request(`${BASE}/999`, {
        method: 'DELETE',
        headers: { cookie: ADMIN_COOKIE, ...ORIGIN_HEADERS },
      })
      expect(res.status).toBe(404)
    })

    it('rejects a non-admin member with 403', async () => {
      const res = await app.request(`${BASE}/1`, {
        method: 'DELETE',
        headers: { cookie: VIEWER_COOKIE, ...ORIGIN_HEADERS },
      })
      expect(res.status).toBe(403)
    })
  })
}
