/**
 * Dashboard results export route tests (issue #102, unit U4).
 *
 * Verifies the extended GET /api/v1/dashboard/results/export handler:
 *   - When scope/variant/format are absent → legacy CSV path (not tested here;
 *     see tests/unit/dashboard-results-routes.test.ts for legacy coverage)
 *   - When any new param is present → U3 createExport service is called and
 *     the response carries the correct headers / stream body
 *
 * Isolation: mocks src/services/results/export.js (createExport + escapeCsv).
 * Must run with DASHBOARD_RESULTS_EXPORT_TEST_ISOLATED=1. Mirrors the
 * dashboard-results-routes.test.ts isolation pattern so mock.module calls do
 * not leak into other tests.
 *
 * KTD8: the createExport mock fixture is typed as
 *   Awaited<ReturnType<typeof createExport>>
 * so the test pins the service ReturnType, not the route response schema.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['DASHBOARD_RESULTS_EXPORT_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('dashboard-results-export (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-results-export] skipped - set DASHBOARD_RESULTS_EXPORT_TEST_ISOLATED=1 to run.'
      )
      expect(process.env['DASHBOARD_RESULTS_EXPORT_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── KTD8 fixture typed against service ReturnType ─────────────────────────

  type ExportResult = Awaited<
    ReturnType<typeof import('../../../../src/services/results/export.js').createExport>
  >

  function makeExportResult(lines: string[], skippedCount = 0): ExportResult {
    return {
      skippedCount,
      rows: (async function* () {
        for (const line of lines) yield line
      })(),
    } satisfies ExportResult
  }

  const mockCreateExport = mock(async (..._args: unknown[]) =>
    makeExportResult(['hash_value,plaintext', 'abc,pass'])
  )

  // ─── Module mocks ────────────────────────────────────────────────────────────

  mock.module('../../../../src/lib/auth.js', () => ({
    auth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const cookie = headers.get('cookie') ?? ''
          if (!cookie.includes('hh.session_token=valid-admin-session')) return null
          return {
            user: { id: '1', email: 'admin@test.local', role: 'admin', banned: null },
            session: {
              userId: '1',
              token: 'tok',
              expiresAt: new Date(Date.now() + 3_600_000),
              projectId: 1,
            },
          }
        },
      },
      handler: async () => new Response('ok'),
    },
  }))

  mock.module('../../../../src/services/auth.js', () => ({
    getUserWithProjects: async (userId: number) => {
      if (userId === 1) return { id: 1, projects: [{ projectId: 1, roles: ['admin'] }] }
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
    issueUserApiKey: mock(async () => ({ apiKey: 'cst_test', metadata: null })),
    revokeUserApiKey: mock(async () => undefined),
    getUserApiKeyMetadata: mock(async () => null),
  }))

  mock.module('../../../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            leftJoin: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: () => ({ offset: () => Promise.resolve([]) }),
                }),
              }),
            }),
          }),
          // Supports the select().from().where().limit() chain used by
          // getHashListById / getCampaignById for ownership checks (item D).
          // Returns a stub that represents a valid resource belonging to projectId=1,
          // so the ownership guard passes for all tests in this file.
          where: () => ({
            limit: () => Promise.resolve([{ id: 1, projectId: 1, name: 'Stub' }]),
          }),
        }),
      }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
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

  // NOTE: resources.js and campaigns.js are NOT mocked here because they re-export
  // dozens of symbols — a partial mock breaks any statically-linked import that
  // expects a missing export (bun:test SyntaxError at link time).
  // Instead, the DB mock below is extended to support the select().from().where().limit()
  // chain used by getHashListById / getCampaignById so the ownership guards (item D)
  // pass transparently.

  // Mock the export service — results.ts imports both createExport and escapeCsv.
  // Both must be present to avoid link-time SyntaxError (KTD8 / trap #2).
  mock.module('../../../../src/services/results/export.js', () => ({
    createExport: mockCreateExport,
    escapeCsv: (val: string | null | undefined): string => {
      if (val == null) return ''
      if (val.includes(',') || val.includes('"')) return `"${val.replace(/"/g, '""')}"`
      return val
    },
    // Additional exports referenced by the module but not exercised here:
    encodeCrackedRow: mock(() => null),
    encodeUncrackedRow: mock((row: { hashValue: string }) => row.hashValue),
    isEmittable: mock(() => true),
    EXPORT_CSV_HEADERS: {
      'cracked-pairs': 'hash_value,plaintext,username,source,campaign,attack,hash_list,cracked_at',
      'plaintext-only': 'plaintext',
      uncracked: 'hash_value',
    },
    JOHN_FORMAT_TAGS: { 0: '$dynamic_0$', 1000: '$NT$' },
  }))

  // ─── App import (after all mocks) ────────────────────────────────────────────

  const { app } = await import('../../../../src/index.js')

  const EXPORT = '/api/v1/dashboard/results/export'

  function makeHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      cookie: 'hh.session_token=valid-admin-session',
      host: 'lab.local',
      origin: 'https://lab.local',
      'x-project-id': '1',
      ...extra,
    }
  }

  beforeEach(() => {
    mockCreateExport.mockReset()
    mockCreateExport.mockImplementation(async () =>
      makeExportResult(['hash_value,plaintext', 'abc,pass'])
    )
  })

  // ─── Happy path ──────────────────────────────────────────────────────────────

  describe('U3 export path (scope/variant/format present)', () => {
    it('streams CSV with correct Content-Type and Content-Disposition', async () => {
      const res = await app.request(`${EXPORT}?scope=project&variant=cracked-pairs&format=csv`, {
        method: 'GET',
        headers: makeHeaders(),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/csv')
      const cd = res.headers.get('content-disposition')
      expect(cd).toContain('attachment')
      expect(cd).toContain('.csv')
    })

    it('streams potfile with text/plain Content-Type and .potfile filename', async () => {
      mockCreateExport.mockImplementation(async () => makeExportResult(['abc:pass'], 0))

      const res = await app.request(
        `${EXPORT}?scope=project&variant=cracked-pairs&format=hashcat-potfile`,
        { method: 'GET', headers: makeHeaders() }
      )

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')
      const cd = res.headers.get('content-disposition')
      expect(cd).toContain('.potfile')
    })

    it('sets x-export-skipped header to skippedCount from service', async () => {
      mockCreateExport.mockImplementation(async () => makeExportResult(['abc:pass'], 7))

      const res = await app.request(
        `${EXPORT}?scope=project&variant=cracked-pairs&format=hashcat-potfile`,
        { method: 'GET', headers: makeHeaders() }
      )

      expect(res.status).toBe(200)
      expect(res.headers.get('x-export-skipped')).toBe('7')
    })

    it('calls createExport with project scope and parsed params', async () => {
      await app.request(`${EXPORT}?scope=project&variant=cracked-pairs&format=csv`, {
        method: 'GET',
        headers: makeHeaders(),
      })

      expect(mockCreateExport).toHaveBeenCalledTimes(1)
      const [_db, params] = mockCreateExport.mock.calls[0]!
      expect(params).toMatchObject({
        scope: 'project',
        projectId: 1,
        variant: 'cracked-pairs',
        format: 'csv',
      })
    })

    it('calls createExport with hash-list scope when hashListId is provided', async () => {
      await app.request(
        `${EXPORT}?scope=hash-list&variant=cracked-pairs&format=csv&hashListId=42`,
        { method: 'GET', headers: makeHeaders() }
      )

      expect(mockCreateExport).toHaveBeenCalledTimes(1)
      const [_db, params] = mockCreateExport.mock.calls[0]!
      expect(params).toMatchObject({
        scope: 'hash-list',
        projectId: 1,
        hashListId: 42,
        variant: 'cracked-pairs',
        format: 'csv',
      })
    })

    it('threads q, startDate, and endDate into createExport filters', async () => {
      // startDate/endDate must be full ISO 8601 datetime strings (isoDateTimeFilterQuery uses .datetime())
      const start = '2025-01-01T00:00:00.000Z'
      const end = '2025-12-31T23:59:59.000Z'
      await app.request(
        `${EXPORT}?scope=project&variant=cracked-pairs&format=csv&q=hello&startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`,
        { method: 'GET', headers: makeHeaders() }
      )

      expect(mockCreateExport).toHaveBeenCalledTimes(1)
      const [_db, params] = mockCreateExport.mock.calls[0]!
      expect(params).toMatchObject({
        scope: 'project',
        variant: 'cracked-pairs',
        format: 'csv',
        filters: { q: 'hello', startDate: start, endDate: end },
      })
    })

    it('streams the generator lines as newline-terminated chunks', async () => {
      mockCreateExport.mockImplementation(async () =>
        makeExportResult(['hash_value,plaintext', 'abc,pass', 'def,word'])
      )

      const res = await app.request(`${EXPORT}?scope=project&variant=cracked-pairs&format=csv`, {
        method: 'GET',
        headers: makeHeaders(),
      })

      const text = await res.text()
      expect(text).toBe('hash_value,plaintext\nabc,pass\ndef,word\n')
    })

    it('defaults absent variant/format to cracked-pairs/csv when scope is provided', async () => {
      await app.request(`${EXPORT}?scope=project`, { method: 'GET', headers: makeHeaders() })

      expect(mockCreateExport).toHaveBeenCalledTimes(1)
      const [_db, params] = mockCreateExport.mock.calls[0]!
      expect(params).toMatchObject({ variant: 'cracked-pairs', format: 'csv' })
    })
  })

  // ─── Scope ID validation ─────────────────────────────────────────────────────

  describe('scope ID validation', () => {
    it('returns 400 when scope=hash-list but hashListId is missing', async () => {
      const res = await app.request(`${EXPORT}?scope=hash-list&variant=cracked-pairs&format=csv`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(400)
      expect(mockCreateExport).not.toHaveBeenCalled()
    })

    it('returns 400 when scope=campaign but campaignId is missing', async () => {
      const res = await app.request(`${EXPORT}?scope=campaign&variant=cracked-pairs&format=csv`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(400)
      expect(mockCreateExport).not.toHaveBeenCalled()
    })

    it('returns 400 for potfile format with uncracked variant', async () => {
      const res = await app.request(
        `${EXPORT}?scope=project&variant=uncracked&format=hashcat-potfile`,
        { method: 'GET', headers: makeHeaders() }
      )
      expect(res.status).toBe(400)
      expect(mockCreateExport).not.toHaveBeenCalled()
    })

    it('returns 400 for potfile format with plaintext-only variant', async () => {
      const res = await app.request(
        `${EXPORT}?scope=project&variant=plaintext-only&format=john-potfile`,
        { method: 'GET', headers: makeHeaders() }
      )
      expect(res.status).toBe(400)
      expect(mockCreateExport).not.toHaveBeenCalled()
    })
  })

  // ─── Legacy path preservation ─────────────────────────────────────────────────

  describe('legacy path (no new params)', () => {
    it('does NOT call createExport when scope/variant/format are all absent', async () => {
      const res = await app.request(EXPORT, { method: 'GET', headers: makeHeaders() })
      // Legacy path returns a CSV stream (may be header-only since db mock returns [])
      expect(res.status).toBe(200)
      expect(mockCreateExport).not.toHaveBeenCalled()
    })
  })
}
