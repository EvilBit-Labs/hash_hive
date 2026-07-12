/**
 * Dashboard AD/LDAP admin reconciliation route contract tests (U7, R12).
 *
 * Validates the global-admin gate (`requireRole('admin')`), the typed-error
 * -> HTTP status mapping for `resolveLinkRequest`, and that the route is
 * present in the served `/api/v1/dashboard/openapi.json` spec. Mocks the
 * service layer and infrastructure (db, redis, BetterAuth) so the suite
 * runs without touching Postgres -- service behavior itself (list/link/
 * reject/idempotency/unique-violation) is covered against a real database
 * in `tests/db/ldap-reconciliation.db.test.ts`.
 *
 * Per the contract-test-mocks-mirror-service-not-schema convention, the
 * mock factories are typed via `typeof svc` so a signature drift in the
 * service surfaces here as a type-check failure.
 *
 * Must run with LDAP_LINK_REQUESTS_ROUTES_TEST_ISOLATED=1 -- mocks
 * lib/auth.js, services/auth.js, services/ldap-reconciliation.js,
 * db/index.js, and ioredis at module scope (mirrors
 * dashboard-projects-create-rbac.test.ts / dashboard-hash-search-routes).
 */

const IS_ISOLATED = process.env['LDAP_LINK_REQUESTS_ROUTES_TEST_ISOLATED'] === '1'

import type { LdapLinkRequest } from '@hashhive/shared'

import { describe, expect, it, mock } from 'bun:test'

if (!IS_ISOLATED) {
  // A plain describe (NOT describe.skip) so this canary test actually
  // executes and would catch a CI phase-gating regression -- mirrors
  // telemetry.test.ts / audit-log.test.ts. describe.skip would prevent
  // this stub itself from running, defeating the point of the canary
  // (code review FIX 2).
  describe('dashboard-ldap-link-requests-routes (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-ldap-link-requests-routes] skipped - set LDAP_LINK_REQUESTS_ROUTES_TEST_ISOLATED=1 to run.'
      )
      expect(process.env['LDAP_LINK_REQUESTS_ROUTES_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // Pull the REAL typed error classes in BEFORE mock.module runs so the
  // mock can re-export the identical class references. The route handler's
  // `err instanceof LdapLinkRequestNotFoundError` checks compare against
  // whatever `services/ldap-reconciliation.js` resolves to under the mock
  // -- re-exporting the real classes (rather than declaring lookalikes)
  // keeps `instanceof` working end-to-end (mirrors
  // crackers-routes.test.ts's `realCompareCrackerVersions` pattern).
  const {
    LdapLinkRequestAlreadyResolvedError,
    LdapLinkRequestNotFoundError,
    LdapLinkTargetAlreadyLinkedError,
    LdapLinkTargetNotFoundError,
  } = await import('../../src/services/ldap-reconciliation.js')

  const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
  const OPERATOR_COOKIE = 'hh.session_token=valid-operator-session'

  // ─── Mock BetterAuth ─────────────────────────────────────────────────

  mock.module('../../src/lib/auth.js', () => ({
    auth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const cookie = headers.get('cookie') ?? ''
          if (
            !cookie.includes('valid-admin-session') &&
            !cookie.includes('valid-operator-session')
          ) {
            return null
          }
          const isAdmin = cookie.includes('valid-admin-session')
          return {
            user: {
              id: isAdmin ? '1' : '2',
              email: isAdmin ? 'admin@test.local' : 'operator@test.local',
              name: isAdmin ? 'Admin' : 'Operator',
              emailVerified: true,
              image: null,
              roles: isAdmin ? ['admin'] : ['operator'],
            },
            session: {
              id: 'sess',
              userId: isAdmin ? '1' : '2',
              token: 'tok',
              expiresAt: new Date(Date.now() + 3_600_000),
              // requireRole is the global tier guard -- no project scope needed.
              projectId: null,
            },
          }
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
    issueUserApiKey: mock(async () => ({ apiKey: 'cst_test', metadata: null })),
    revokeUserApiKey: mock(async () => undefined),
    getUserApiKeyMetadata: mock(async () => null),
  }))

  // ─── Mock the reconciliation service layer ────────────────────────────

  type ReconciliationService = typeof import('../../src/services/ldap-reconciliation.js')

  const nowIso = new Date('2026-01-01T00:00:00.000Z').toISOString()

  const makeLinkRequestView = (
    overrides: Partial<LdapLinkRequest> = {}
  ): Awaited<ReturnType<ReconciliationService['listPendingLinkRequests']>>['data'][number] => ({
    id: 7,
    username: 'jdoe',
    derivedEmail: 'jdoe@lab.local',
    resolvedRole: 'operator',
    matchedUserId: 3,
    status: 'pending',
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  })

  const mockListPendingLinkRequests: ReconciliationService['listPendingLinkRequests'] = mock(
    async (pagination) => ({
      data: [makeLinkRequestView()],
      total: 1,
      limit: pagination.limit,
      offset: pagination.offset,
    })
  )

  let resolveImpl: ReconciliationService['resolveLinkRequest'] = mock(async (input) => {
    if (input.action === 'link') {
      return makeLinkRequestView({ status: 'linked' })
    }
    return makeLinkRequestView({ status: 'rejected' })
  })
  const mockResolveLinkRequest: ReconciliationService['resolveLinkRequest'] = mock((...args) =>
    resolveImpl(...args)
  )

  mock.module('../../src/services/ldap-reconciliation.js', () => ({
    listPendingLinkRequests: mockListPendingLinkRequests,
    resolveLinkRequest: mockResolveLinkRequest,
    LdapLinkRequestNotFoundError,
    LdapLinkRequestAlreadyResolvedError,
    LdapLinkTargetNotFoundError,
    LdapLinkTargetAlreadyLinkedError,
  }))

  // ─── Mock DB + Redis (imported transitively by the rest of the app) ──

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

  const { app } = await import('../../src/index.js')

  // ─── Helpers ─────────────────────────────────────────────────────────

  const LIST_PATH = '/api/v1/dashboard/ldap-link-requests'
  const resolvePath = (id: number) => `/api/v1/dashboard/ldap-link-requests/${id}/resolve`

  // Origin + Host satisfy the CSRF same-origin guard for POST (GET is a
  // SAFE method and skips the check).
  const headersFor = (cookie?: string) => ({
    ...(cookie ? { cookie } : {}),
    'content-type': 'application/json',
    origin: 'http://lab.local',
    host: 'lab.local',
  })

  describe('GET /ldap-link-requests: requires global admin role', () => {
    it('returns 200 with the pending queue for an admin', async () => {
      const res = await app.request(LIST_PATH, { headers: headersFor(ADMIN_COOKIE) })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { data?: unknown[]; total?: number }
      expect(json.data).toHaveLength(1)
      expect(json.total).toBe(1)
    })

    it('returns 403 for global operator (insufficient tier)', async () => {
      const res = await app.request(LIST_PATH, { headers: headersFor(OPERATOR_COOKIE) })
      expect(res.status).toBe(403)
      const json = (await res.json()) as { error?: { code?: string } }
      expect(json.error?.code).toBe('AUTHZ_INSUFFICIENT_PERMISSIONS')
    })

    it('returns 401 without a session cookie', async () => {
      const res = await app.request(LIST_PATH, { headers: headersFor() })
      expect(res.status).toBe(401)
    })
  })

  describe('POST /ldap-link-requests/{id}/resolve: requires global admin role', () => {
    it('returns 403 for global operator (insufficient tier), service not invoked', async () => {
      const callsBefore = mockResolveLinkRequest.mock.calls.length
      const res = await app.request(resolvePath(7), {
        method: 'POST',
        headers: headersFor(OPERATOR_COOKIE),
        body: JSON.stringify({ action: 'reject' }),
      })
      expect(res.status).toBe(403)
      expect(mockResolveLinkRequest.mock.calls.length).toBe(callsBefore)
    })

    it('returns 401 without a session cookie', async () => {
      const res = await app.request(resolvePath(7), {
        method: 'POST',
        headers: headersFor(),
        body: JSON.stringify({ action: 'reject' }),
      })
      expect(res.status).toBe(401)
    })
  })

  describe('POST /ldap-link-requests/{id}/resolve: typed-error -> HTTP mapping (admin)', () => {
    it('returns 200 with the linked request on a successful link', async () => {
      resolveImpl = mock(async () => makeLinkRequestView({ status: 'linked' }))
      const res = await app.request(resolvePath(7), {
        method: 'POST',
        headers: headersFor(ADMIN_COOKIE),
        body: JSON.stringify({ action: 'link', targetUserId: 5 }),
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { linkRequest?: { status?: string } }
      expect(json.linkRequest?.status).toBe('linked')
    })

    it('returns 200 with the rejected request on a successful reject', async () => {
      resolveImpl = mock(async () => makeLinkRequestView({ status: 'rejected' }))
      const res = await app.request(resolvePath(7), {
        method: 'POST',
        headers: headersFor(ADMIN_COOKIE),
        body: JSON.stringify({ action: 'reject' }),
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { linkRequest?: { status?: string } }
      expect(json.linkRequest?.status).toBe('rejected')
    })

    it('returns 400 when action is "link" without a targetUserId', async () => {
      const res = await app.request(resolvePath(7), {
        method: 'POST',
        headers: headersFor(ADMIN_COOKIE),
        body: JSON.stringify({ action: 'link' }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 404 when the request id does not exist', async () => {
      resolveImpl = mock(async () => {
        throw new LdapLinkRequestNotFoundError(999)
      })
      const res = await app.request(resolvePath(999), {
        method: 'POST',
        headers: headersFor(ADMIN_COOKIE),
        body: JSON.stringify({ action: 'reject' }),
      })
      expect(res.status).toBe(404)
      const json = (await res.json()) as { error?: { code?: string } }
      expect(json.error?.code).toBe('LDAP_LINK_REQUEST_NOT_FOUND')
    })

    it('returns 409 when the request was already resolved', async () => {
      resolveImpl = mock(async () => {
        throw new LdapLinkRequestAlreadyResolvedError(7, 'linked')
      })
      const res = await app.request(resolvePath(7), {
        method: 'POST',
        headers: headersFor(ADMIN_COOKIE),
        body: JSON.stringify({ action: 'reject' }),
      })
      expect(res.status).toBe(409)
      const json = (await res.json()) as { error?: { code?: string } }
      expect(json.error?.code).toBe('LDAP_LINK_REQUEST_ALREADY_RESOLVED')
    })

    it('returns 404 when the link target user does not exist', async () => {
      resolveImpl = mock(async () => {
        throw new LdapLinkTargetNotFoundError(404_404)
      })
      const res = await app.request(resolvePath(7), {
        method: 'POST',
        headers: headersFor(ADMIN_COOKIE),
        body: JSON.stringify({ action: 'link', targetUserId: 404_404 }),
      })
      expect(res.status).toBe(404)
      const json = (await res.json()) as { error?: { code?: string } }
      expect(json.error?.code).toBe('LDAP_LINK_TARGET_NOT_FOUND')
    })

    it('returns 409 when the link would violate identity uniqueness', async () => {
      resolveImpl = mock(async () => {
        throw new LdapLinkTargetAlreadyLinkedError(5, 'jdoe')
      })
      const res = await app.request(resolvePath(7), {
        method: 'POST',
        headers: headersFor(ADMIN_COOKIE),
        body: JSON.stringify({ action: 'link', targetUserId: 5 }),
      })
      expect(res.status).toBe(409)
      const json = (await res.json()) as { error?: { code?: string } }
      expect(json.error?.code).toBe('LDAP_LINK_TARGET_ALREADY_LINKED')
    })
  })

  describe('/api/v1/dashboard/openapi.json: route-as-spec presence (U7)', () => {
    it('includes the ldap-link-requests list and resolve paths', async () => {
      const res = await app.request('/api/v1/dashboard/openapi.json')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { paths?: Record<string, Record<string, unknown>> }
      const paths = Object.keys(body.paths ?? {})

      const listPath = paths.find((p) => p.startsWith('/ldap-link-requests') && !p.includes('{id}'))
      expect(listPath).toBeDefined()
      expect(body.paths?.[listPath as string]?.['get']).toBeDefined()

      const resolveOpenApiPath = paths.find((p) => p.includes('/ldap-link-requests/{id}/resolve'))
      expect(resolveOpenApiPath).toBeDefined()
      expect(body.paths?.[resolveOpenApiPath as string]?.['post']).toBeDefined()
    })
  })
}
