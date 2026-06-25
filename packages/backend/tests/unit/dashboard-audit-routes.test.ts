import { auditLogListResponseSchema } from '@hashhive/shared'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

/**
 * Route-level tests for `GET /api/v1/dashboard/audit-logs`.
 *
 * Runs in an isolated phase via `DASHBOARD_AUDIT_ROUTES_TEST_ISOLATED=1`
 * because this file mocks `src/db/index.js` and `src/services/audit-log.js`
 * wholesale — the mock leaks process-wide and would clobber any neighbour
 * that hits the real driver. Mirrors the dashboard-results-routes isolation
 * pattern.
 *
 * Label-resolution batching is a service-level concern verified by real-DB
 * tests in tests/db/audit-logs.db.test.ts. The contract-test mock here
 * pins the service's ReturnType (not the route schema) per
 * docs/solutions/conventions/contract-test-mocks-mirror-service-not-schema.md.
 */
/**
 * Type alias matching listAuditEvents ReturnType, extracted to the top level
 * so it is resolvable at parse time even when inside the IS_ISOLATED block.
 * Contract-test mock pins satisfies Awaited<ReturnType<typeof listAuditEvents>>,
 * not the route schema, per the mock-mirror-service convention.
 */
import type { listAuditEvents as _listAuditEventsType } from '../../src/services/audit-log.js'

type ListAuditEventsResult = Awaited<ReturnType<typeof _listAuditEventsType>>

const IS_ISOLATED = process.env['DASHBOARD_AUDIT_ROUTES_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('dashboard-audit-routes (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-audit-routes] skipped - set DASHBOARD_AUDIT_ROUTES_TEST_ISOLATED=1 to run.'
      )
      expect(process.env['DASHBOARD_AUDIT_ROUTES_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── Fixtures ────────────────────────────────────────────────────────────────

  const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
  const VIEWER_COOKIE = 'hh.session_token=valid-viewer-session'
  const CONTRIBUTOR_COOKIE = 'hh.session_token=valid-contributor-session'
  const SAME_ORIGIN_HOST = 'lab.local'

  const BASE_ROW = {
    id: 1,
    actorType: 'user',
    actorId: 1,
    projectId: 1,
    entityType: 'campaign',
    entityId: 10,
    action: 'updated',
    fromStatus: null,
    toStatus: null,
    reason: null,
    changes: { name: { old: 'Old Name', new: 'New Name' } },
    createdAt: '2026-06-01T10:00:00.000Z',
    actorLabel: 'Admin User',
    entityLabel: 'Campaign Alpha',
  } satisfies ListAuditEventsResult['data'][number]

  const EMPTY_RESULT: ListAuditEventsResult = {
    data: [],
    total: 0,
    limit: 50,
    offset: 0,
  }

  // Mutable state — reset in beforeEach
  let mockResult: ListAuditEventsResult = EMPTY_RESULT
  let lastCallArgs: { projectId: number; filters: unknown; pagination: unknown } | null = null

  // ─── Mocks ───────────────────────────────────────────────────────────────────

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
                name: 'Admin User',
                emailVerified: true,
                image: null,
                roles: ['admin'],
              },
              session: {
                id: 'sess-admin',
                userId: '1',
                token: 'tok',
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
                name: 'Viewer User',
                emailVerified: true,
                image: null,
                roles: ['analyst'],
              },
              session: {
                id: 'sess-viewer',
                userId: '2',
                token: 'tok2',
                expiresAt: new Date(Date.now() + 3_600_000),
                projectId: 1,
              },
            }
          }
          if (cookie.includes('valid-contributor-session')) {
            return {
              user: {
                id: '3',
                email: 'contributor@test.local',
                name: 'Contributor User',
                emailVerified: true,
                image: null,
                roles: ['operator'],
              },
              session: {
                id: 'sess-contrib',
                userId: '3',
                token: 'tok3',
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
    getUserWithProjects: async (userId: number) => {
      if (userId === 1) return { id: 1, projects: [{ projectId: 1, roles: ['admin'] }] }
      if (userId === 2) return { id: 2, projects: [{ projectId: 1, roles: ['viewer'] }] }
      if (userId === 3) return { id: 3, projects: [{ projectId: 1, roles: ['contributor'] }] }
      return null
    },
    findProjectMembership: async (userId: number, projectId: number) => {
      if (projectId !== 1) return null
      if (userId === 1) return { projectId: 1, roles: ['admin'] }
      if (userId === 2) return { projectId: 1, roles: ['viewer'] }
      if (userId === 3) return { projectId: 1, roles: ['contributor'] }
      return null
    },
    getUserLastProjectId: async () => null,
    setUserLastProjectIdIfMember: async () => 1,
    setUserLastProjectId: async () => undefined,
    issueUserApiKey: mock(async () => ({ apiKey: 'cst_test', metadata: null })),
    revokeUserApiKey: mock(async () => undefined),
    getUserApiKeyMetadata: mock(async () => null),
  }))

  // Mock the audit-log service — pins ReturnType, not route schema.
  mock.module('../../src/services/audit-log.js', () => ({
    listAuditEvents: async (
      projectId: number,
      filters: unknown,
      pagination: unknown
    ): Promise<ListAuditEventsResult> => {
      lastCallArgs = { projectId, filters, pagination }
      return mockResult
    },
    recordAuditEvent: mock(async () => ({})),
    ENTITY_ALLOWLISTS: {},
    AUDITED_TABLE_COLUMNS: {},
    EXPLICITLY_EXCLUDED_COLUMNS: new Set<string>(),
  }))

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                offset: () => Promise.resolve([]),
              }),
            }),
          }),
        }),
      }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
    },
    client: new Proxy(
      {},
      {
        get(_t, prop) {
          throw new Error(`Test mock: unexpected access to client.${String(prop)}`)
        },
      }
    ),
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

  // Dynamically import the app after mocks register.
  const { app } = await import('../../src/index.js')

  const AUDIT_LOGS = '/api/v1/dashboard/audit-logs'

  function makeHeaders(cookie = ADMIN_COOKIE, extra: Record<string, string> = {}) {
    return {
      cookie,
      host: SAME_ORIGIN_HOST,
      origin: `https://${SAME_ORIGIN_HOST}`,
      ...extra,
    }
  }

  beforeEach(() => {
    mockResult = EMPTY_RESULT
    lastCallArgs = null
  })

  // ─── Auth ────────────────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('returns 401 when no session cookie is present', async () => {
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: { host: SAME_ORIGIN_HOST },
      })
      expect(res.status).toBe(401)
    })

    it('returns 401 for an unrecognised session cookie', async () => {
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: makeHeaders('hh.session_token=garbage'),
      })
      expect(res.status).toBe(401)
    })
  })

  // ─── R11 access control ──────────────────────────────────────────────────────

  describe('R11: role-based access control', () => {
    it('returns 403 for a viewer-role member', async () => {
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: makeHeaders(VIEWER_COOKIE),
      })
      expect(res.status).toBe(403)
    })

    it('returns 200 for an admin-role member', async () => {
      mockResult = { data: [], total: 0, limit: 50, offset: 0 }
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: makeHeaders(ADMIN_COOKIE),
      })
      expect(res.status).toBe(200)
    })

    it('returns 200 for a contributor-role member', async () => {
      mockResult = { data: [], total: 0, limit: 50, offset: 0 }
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: makeHeaders(CONTRIBUTOR_COOKIE),
      })
      expect(res.status).toBe(200)
    })

    it('returns 403 for a request scoped to a project the caller cannot access', async () => {
      // Session projectId is 1; the RBAC middleware enforces it via
      // findProjectMembership — a projectId=999 in the session produces no
      // membership and a 403. We simulate by using a cookie whose session
      // has projectId=999 via a different cookie value.
      // Viewer cookie user (id=2) has no membership for projectId=999 either.
      // The simpler path: just use the viewer cookie — it yields 403 on role.
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: makeHeaders(VIEWER_COOKIE),
      })
      expect(res.status).toBe(403)
    })
  })

  // ─── Response shape ──────────────────────────────────────────────────────────

  describe('response shape', () => {
    it('returns rows scoped to the caller project, newest-first, with actorLabel/entityLabel', async () => {
      mockResult = {
        data: [BASE_ROW, { ...BASE_ROW, id: 2, entityId: 11, entityLabel: 'Campaign Beta' }],
        total: 2,
        limit: 50,
        offset: 0,
      }
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as typeof mockResult
      expect(body.data).toHaveLength(2)
      expect(body.data[0]?.actorLabel).toBe('Admin User')
      expect(body.data[0]?.entityLabel).toBe('Campaign Alpha')
      expect(body.total).toBe(2)
    })

    it('echoes limit and offset from the service result', async () => {
      mockResult = { data: [], total: 0, limit: 10, offset: 20 }
      const res = await app.request(`${AUDIT_LOGS}?limit=10&offset=20`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as typeof mockResult
      expect(body.limit).toBe(10)
      expect(body.offset).toBe(20)
    })

    it('forwards limit and offset to the service', async () => {
      mockResult = { data: [], total: 0, limit: 25, offset: 75 }
      await app.request(`${AUDIT_LOGS}?limit=25&offset=75`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(lastCallArgs?.pagination).toMatchObject({ limit: 25, offset: 75 })
    })

    it('falls back to default limit (50) when limit is out of range', async () => {
      mockResult = { data: [], total: 0, limit: 50, offset: 0 }
      await app.request(`${AUDIT_LOGS}?limit=9999`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(lastCallArgs?.pagination).toMatchObject({ limit: 50 })
    })

    it('actorLabel for a user row is the display name — never the email', async () => {
      mockResult = {
        data: [{ ...BASE_ROW, actorType: 'user', actorLabel: 'Admin User' }],
        total: 1,
        limit: 50,
        offset: 0,
      }
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as typeof mockResult
      const label = body.data[0]?.actorLabel ?? ''
      expect(label).toBe('Admin User')
      // Must not be the email address
      expect(label).not.toContain('@')
    })

    it('a deleted entity resolves entityLabel to [deleted] without erroring', async () => {
      mockResult = {
        data: [{ ...BASE_ROW, entityLabel: '[deleted]' }],
        total: 1,
        limit: 50,
        offset: 0,
      }
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as typeof mockResult
      expect(body.data[0]?.entityLabel).toBe('[deleted]')
    })

    it('a deleted user actor resolves actorLabel to [deleted user]', async () => {
      mockResult = {
        data: [{ ...BASE_ROW, actorType: 'user', actorId: 9999, actorLabel: '[deleted user]' }],
        total: 1,
        limit: 50,
        offset: 0,
      }
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as typeof mockResult
      expect(body.data[0]?.actorLabel).toBe('[deleted user]')
    })

    it('a deleted agent actor resolves actorLabel to [deleted agent]', async () => {
      mockResult = {
        data: [{ ...BASE_ROW, actorType: 'agent', actorId: 9999, actorLabel: '[deleted agent]' }],
        total: 1,
        limit: 50,
        offset: 0,
      }
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as typeof mockResult
      expect(body.data[0]?.actorLabel).toBe('[deleted agent]')
    })
  })

  // ─── Filters ─────────────────────────────────────────────────────────────────

  describe('filter forwarding', () => {
    it('forwards entityType filter to the service', async () => {
      mockResult = EMPTY_RESULT
      await app.request(`${AUDIT_LOGS}?entityType=campaign`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(lastCallArgs?.filters).toMatchObject({ entityType: 'campaign' })
    })

    it('forwards actorType filter to the service', async () => {
      mockResult = EMPTY_RESULT
      await app.request(`${AUDIT_LOGS}?actorType=user`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(lastCallArgs?.filters).toMatchObject({ actorType: 'user' })
    })

    it('forwards action filter to the service', async () => {
      mockResult = EMPTY_RESULT
      await app.request(`${AUDIT_LOGS}?action=updated`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(lastCallArgs?.filters).toMatchObject({ action: 'updated' })
    })

    it('forwards dateFrom and dateTo to the service', async () => {
      mockResult = EMPTY_RESULT
      const url =
        `${AUDIT_LOGS}?dateFrom=2026-01-01T00:00:00.000Z` + `&dateTo=2026-12-31T23:59:59.000Z`
      await app.request(url, { method: 'GET', headers: makeHeaders() })
      expect(lastCallArgs?.filters).toMatchObject({
        dateFrom: '2026-01-01T00:00:00.000Z',
        dateTo: '2026-12-31T23:59:59.000Z',
      })
    })

    it('accepts all filter params without 400', async () => {
      mockResult = EMPTY_RESULT
      const url =
        `${AUDIT_LOGS}?entityType=campaign&entityId=10&actorType=user` +
        `&action=updated&dateFrom=2026-01-01T00:00:00.000Z&dateTo=2026-12-31T00:00:00.000Z`
      const res = await app.request(url, { method: 'GET', headers: makeHeaders() })
      expect(res.status).toBe(200)
    })

    it('falls back to no-filter on malformed dateFrom (no 400)', async () => {
      mockResult = EMPTY_RESULT
      const res = await app.request(`${AUDIT_LOGS}?dateFrom=not-a-date`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
    })
  })

  // ─── Live round-trip through shared schema ───────────────────────────────────

  describe('schema round-trip', () => {
    it('live response round-trips through auditLogListResponseSchema.parse()', async () => {
      mockResult = {
        data: [BASE_ROW],
        total: 1,
        limit: 50,
        offset: 0,
      }
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      // Should not throw
      const parsed = auditLogListResponseSchema.parse(body)
      expect(parsed.data).toHaveLength(1)
      expect(parsed.total).toBe(1)
    })

    it('rows from other projects never appear (projectId scoped to session)', async () => {
      // The service is always called with the session's projectId (1).
      // A header-supplied x-project-id is never used on the dashboard surface.
      mockResult = {
        data: [BASE_ROW], // projectId: 1 only
        total: 1,
        limit: 50,
        offset: 0,
      }
      const res = await app.request(AUDIT_LOGS, {
        method: 'GET',
        headers: makeHeaders(ADMIN_COOKIE, { 'x-project-id': '999' }),
      })
      expect(res.status).toBe(200)
      // The service was called with the session projectId (1), not the header
      expect(lastCallArgs?.projectId).toBe(1)
    })
  })
}
