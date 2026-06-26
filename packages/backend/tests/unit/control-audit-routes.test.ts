/**
 * Route-level tests for `GET /api/v1/control/audit-logs`.
 *
 * Runs in an isolated phase via `CONTROL_AUDIT_ROUTES_TEST_ISOLATED=1`
 * because this file mocks `src/services/audit-log.js` and
 * `src/routes/control/helpers.js` wholesale — the mocks leak process-wide
 * and would clobber any neighbour that hits the real middleware chain.
 *
 * Mirrors the control-hashlists-routes.test.ts isolation pattern.
 *
 * Contract-test mock pins satisfies Awaited<ReturnType<typeof listAuditEvents>>,
 * not the route schema, per the mock-mirror-service convention documented in
 * docs/solutions/conventions/contract-test-mocks-mirror-service-not-schema.md.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

import type { listAuditEvents as _listAuditEventsType } from '../../src/services/audit-log.js'

type ListAuditEventsResult = Awaited<ReturnType<typeof _listAuditEventsType>>

const IS_ISOLATED = process.env['CONTROL_AUDIT_ROUTES_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('control-audit-routes (skipped - runs in isolated phase)', () => {
    it('runs only with CONTROL_AUDIT_ROUTES_TEST_ISOLATED=1', () => {
      expect(true).toBe(true)
    })
  })
} else {
  // ─── Fixtures ────────────────────────────────────────────────────────────────

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

  // Mutable per-test state
  let mockResult: ListAuditEventsResult = EMPTY_RESULT
  let lastCallArgs: { projectId: number; filters: unknown; pagination: unknown } | null = null

  // Mutable membership state — controls RBAC behaviour
  let activeMembershipRoles: string[] = ['admin']
  let activeProjectId: number | null = 1

  // ─── Mocks ───────────────────────────────────────────────────────────────────

  // Stub requireProjectRole so we can drive RBAC from test state.
  // The real implementation calls requireProjectMembership then checks roles;
  // we replicate that exact two-failure mode: missing project (400-equivalent
  // thrown as Error), wrong role (throws ControlApiError with status 403).
  mock.module('../../src/routes/control/helpers.js', () => ({
    requireProjectMembership: async () => {
      if (activeProjectId === null) {
        const err = new Error('No project selected — include X-Project-Id header')
        ;(err as Error & { status?: number }).status = 400
        throw err
      }
      return { projectId: activeProjectId, roles: activeMembershipRoles }
    },
    requireProjectRole: async (_c: unknown, ...requiredRoles: string[]) => {
      if (activeProjectId === null) {
        const err = new Error('No project selected — include X-Project-Id header')
        ;(err as Error & { status?: number }).status = 400
        throw err
      }
      const hasRole = activeMembershipRoles.some((r) => requiredRoles.includes(r))
      if (!hasRole) {
        const err = new Error(`Requires one of: ${requiredRoles.join(', ')}`)
        ;(err as Error & { status?: number }).status = 403
        throw err
      }
      return { projectId: activeProjectId, roles: activeMembershipRoles }
    },
    controlErrorResponse: (
      c: { json: (body: unknown, status: number) => Response },
      err: unknown
    ) => {
      // Minimal problem-details-shaped stub so RBAC tests can assert on status/type.
      if (err instanceof Error && 'status' in err) {
        const status = (err as Error & { status?: number }).status ?? 500
        const problemType =
          status === 403
            ? 'https://hashhive.dev/errors/forbidden'
            : status === 400
              ? 'https://hashhive.dev/errors/validation'
              : 'https://hashhive.dev/errors/internal'
        return c.json(
          { type: problemType, title: err.message, status, detail: err.message },
          status
        )
      }
      const message = err instanceof Error ? err.message : 'unknown'
      return c.json(
        {
          type: 'https://hashhive.dev/errors/internal',
          title: 'internal',
          detail: message,
          status: 500,
        },
        500
      )
    },
    ControlApiError: class ControlApiError extends Error {
      constructor(
        public status: number,
        public code: string,
        message: string
      ) {
        super(message)
        this.name = 'ControlApiError'
      }
    },
  }))

  // Stub listAuditEvents — pins ReturnType, not route schema.
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

  // Dynamically require the route AFTER mocks register.
  const { controlAuditLogRoutes } = require('../../src/routes/control/audit-logs.js')
  const { Hono } = require('hono')

  function makeApp() {
    // oxlint-disable-next-line typescript/no-explicit-any -- dynamically require()d Hono
    const app = new (Hono as any)()
    app.route('/', controlAuditLogRoutes)
    return app
  }

  // ─── Reset per test ──────────────────────────────────────────────────────────

  beforeEach(() => {
    mockResult = EMPTY_RESULT
    lastCallArgs = null
    activeMembershipRoles = ['admin']
    activeProjectId = 1
  })

  // ─── R11: auth and role-based access control ─────────────────────────────────

  describe('R11: role-based access control', () => {
    it('returns 403 problem+json for a viewer-role API key', async () => {
      activeMembershipRoles = ['viewer']

      const app = makeApp()
      const res = await app.request('/', { method: 'GET' })

      expect(res.status).toBe(403)
      const body = (await res.json()) as { type?: string }
      expect(body.type).toContain('forbidden')
    })

    it('returns 200 for an admin-role API key', async () => {
      activeMembershipRoles = ['admin']
      mockResult = EMPTY_RESULT

      const app = makeApp()
      const res = await app.request('/', { method: 'GET' })
      expect(res.status).toBe(200)
    })

    it('returns 200 for a contributor-role API key', async () => {
      activeMembershipRoles = ['contributor']
      mockResult = EMPTY_RESULT

      const app = makeApp()
      const res = await app.request('/', { method: 'GET' })
      expect(res.status).toBe(200)
    })

    it('returns 400/500 when no project is selected (middleware throws)', async () => {
      activeProjectId = null

      const app = makeApp()
      const res = await app.request('/', { method: 'GET' })

      // The controlErrorResponse stub maps status 400 from the thrown error;
      // the service must not have been called.
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(lastCallArgs).toBeNull()
    })

    it('returns 403 for cross-project access (no membership)', async () => {
      // Simulate a valid API key whose project membership check fails —
      // modelled by setting roles to an empty array so requireProjectRole
      // finds no matching role.
      activeMembershipRoles = []

      const app = makeApp()
      const res = await app.request('/', { method: 'GET' })

      expect(res.status).toBe(403)
      expect(lastCallArgs).toBeNull()
    })
  })

  // ─── Response shape (Paginated<T> with items key) ────────────────────────────

  describe('response shape', () => {
    it('returns 200 with Paginated<AuditLog> shape using items key', async () => {
      mockResult = {
        data: [BASE_ROW],
        total: 1,
        limit: 50,
        offset: 0,
      }

      const app = makeApp()
      const res = await app.request('/', { method: 'GET' })

      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        items?: unknown[]
        total?: number
        limit?: number
        offset?: number
      }
      // Control surface uses `items`, not `data`
      expect(Array.isArray(body.items)).toBe(true)
      expect(body.items).toHaveLength(1)
      expect(body.total).toBe(1)
      expect(typeof body.limit).toBe('number')
      expect(typeof body.offset).toBe('number')
    })

    it('includes actorLabel and entityLabel in each row', async () => {
      mockResult = {
        data: [BASE_ROW],
        total: 1,
        limit: 50,
        offset: 0,
      }

      const app = makeApp()
      const res = await app.request('/', { method: 'GET' })
      const body = (await res.json()) as {
        items?: Array<{ actorLabel?: string; entityLabel?: string }>
      }

      expect(body.items?.[0]?.actorLabel).toBe('Admin User')
      expect(body.items?.[0]?.entityLabel).toBe('Campaign Alpha')
    })

    it('actorLabel for a user row is the display name — never the email', async () => {
      mockResult = {
        data: [{ ...BASE_ROW, actorType: 'user', actorLabel: 'Admin User' }],
        total: 1,
        limit: 50,
        offset: 0,
      }

      const app = makeApp()
      const res = await app.request('/', { method: 'GET' })
      const body = (await res.json()) as { items?: Array<{ actorLabel?: string }> }
      const label = body.items?.[0]?.actorLabel ?? ''

      expect(label).toBe('Admin User')
      // The shared service guarantees no email; assert it here as a contract check
      expect(label).not.toContain('@')
    })

    it('rows are scoped to the caller project (projectId passed to service)', async () => {
      mockResult = EMPTY_RESULT
      activeProjectId = 7

      const app = makeApp()
      await app.request('/', { method: 'GET' })

      expect(lastCallArgs?.projectId).toBe(7)
    })

    it('forwards default limit (50) and offset (0) when not supplied', async () => {
      mockResult = EMPTY_RESULT

      const app = makeApp()
      await app.request('/', { method: 'GET' })

      expect(lastCallArgs?.pagination).toMatchObject({ limit: 50, offset: 0 })
    })

    it('forwards explicit limit and offset to the service', async () => {
      mockResult = { data: [], total: 0, limit: 25, offset: 50 }

      const app = makeApp()
      await app.request('/?limit=25&offset=50', { method: 'GET' })

      expect(lastCallArgs?.pagination).toMatchObject({ limit: 25, offset: 50 })
    })

    it('echoes limit and offset from the query in the response envelope', async () => {
      mockResult = { data: [], total: 0, limit: 10, offset: 20 }

      const app = makeApp()
      const res = await app.request('/?limit=10&offset=20', { method: 'GET' })
      const body = (await res.json()) as { limit?: number; offset?: number }

      expect(body.limit).toBe(10)
      expect(body.offset).toBe(20)
    })

    it('a deleted entity resolves entityLabel to [deleted] without erroring', async () => {
      mockResult = {
        data: [{ ...BASE_ROW, entityLabel: '[deleted]' }],
        total: 1,
        limit: 50,
        offset: 0,
      }

      const app = makeApp()
      const res = await app.request('/', { method: 'GET' })
      const body = (await res.json()) as { items?: Array<{ entityLabel?: string }> }

      expect(body.items?.[0]?.entityLabel).toBe('[deleted]')
    })

    it('a deleted user actor resolves actorLabel to [deleted user]', async () => {
      mockResult = {
        data: [{ ...BASE_ROW, actorType: 'user', actorId: 9999, actorLabel: '[deleted user]' }],
        total: 1,
        limit: 50,
        offset: 0,
      }

      const app = makeApp()
      const res = await app.request('/', { method: 'GET' })
      const body = (await res.json()) as { items?: Array<{ actorLabel?: string }> }

      expect(body.items?.[0]?.actorLabel).toBe('[deleted user]')
    })
  })

  // ─── Filter forwarding ───────────────────────────────────────────────────────

  describe('filter forwarding', () => {
    it('forwards entityType filter to the service', async () => {
      mockResult = EMPTY_RESULT

      const app = makeApp()
      await app.request('/?entityType=campaign', { method: 'GET' })

      expect(lastCallArgs?.filters).toMatchObject({ entityType: 'campaign' })
    })

    it('forwards actorType filter to the service', async () => {
      mockResult = EMPTY_RESULT

      const app = makeApp()
      await app.request('/?actorType=user', { method: 'GET' })

      expect(lastCallArgs?.filters).toMatchObject({ actorType: 'user' })
    })

    it('forwards action filter to the service', async () => {
      mockResult = EMPTY_RESULT

      const app = makeApp()
      await app.request('/?action=updated', { method: 'GET' })

      expect(lastCallArgs?.filters).toMatchObject({ action: 'updated' })
    })

    it('forwards entityId filter to the service', async () => {
      mockResult = EMPTY_RESULT

      const app = makeApp()
      await app.request('/?entityId=42', { method: 'GET' })

      expect(lastCallArgs?.filters).toMatchObject({ entityId: 42 })
    })

    it('forwards dateFrom and dateTo to the service', async () => {
      mockResult = EMPTY_RESULT

      const app = makeApp()
      await app.request('/?dateFrom=2026-01-01T00:00:00.000Z&dateTo=2026-12-31T23:59:59.000Z', {
        method: 'GET',
      })

      expect(lastCallArgs?.filters).toMatchObject({
        dateFrom: '2026-01-01T00:00:00.000Z',
        dateTo: '2026-12-31T23:59:59.000Z',
      })
    })

    it('accepts all filter params together without 4xx', async () => {
      mockResult = EMPTY_RESULT

      const app = makeApp()
      const res = await app.request(
        '/?entityType=campaign&entityId=10&actorType=user&action=updated' +
          '&dateFrom=2026-01-01T00:00:00.000Z&dateTo=2026-12-31T00:00:00.000Z',
        { method: 'GET' }
      )

      expect(res.status).toBe(200)
    })

    it('falls back to no-filter on malformed dateFrom (permissive posture, no 400)', async () => {
      mockResult = EMPTY_RESULT

      const app = makeApp()
      const res = await app.request('/?dateFrom=not-a-date', { method: 'GET' })

      expect(res.status).toBe(200)
      // dateFrom should be absent (catch returned undefined)
      const filters = lastCallArgs?.filters as Record<string, unknown> | undefined
      expect(filters?.dateFrom).toBeUndefined()
    })

    it('filter parity: accepts all filter keys defined on the dashboard endpoint', async () => {
      // Ensures the control surface accepts the same filter vocabulary as
      // dashboard (R8 parity). All six filter params must pass validation.
      mockResult = EMPTY_RESULT

      const app = makeApp()
      const res = await app.request(
        '/?entityType=agent&entityId=5&actorType=agent&action=created' +
          '&dateFrom=2026-06-01T00:00:00.000Z&dateTo=2026-06-30T23:59:59.000Z',
        { method: 'GET' }
      )

      expect(res.status).toBe(200)
      expect(lastCallArgs?.filters).toMatchObject({
        entityType: 'agent',
        entityId: 5,
        actorType: 'agent',
        action: 'created',
        dateFrom: '2026-06-01T00:00:00.000Z',
        dateTo: '2026-06-30T23:59:59.000Z',
      })
    })
  })
} // end IS_ISOLATED
