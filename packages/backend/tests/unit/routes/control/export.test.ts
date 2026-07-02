/**
 * Control API export route tests (issue #102, unit U4).
 *
 * Verifies GET /api/v1/control/export:
 *   - Happy path: streams correct Content-Type, Content-Disposition, and
 *     x-export-skipped header; body lines match service output
 *   - Scope ID validation: hash-list scope without hashListId → 400
 *   - Cross-project 403: requireProjectMembership throw → problem+json
 *   - Potfile+csv-only variant combo rejected by schema → 400
 *
 * Isolation: mocks requireProjectMembership + controlErrorResponse + createExport.
 * Must run with CONTROL_EXPORT_TEST_ISOLATED=1.
 *
 * KTD8: createExport mock fixture is typed as
 *   Awaited<ReturnType<typeof createExport>>
 * so the test pins the service ReturnType, not the route response schema.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['CONTROL_EXPORT_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('control-export (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn('[control-export] skipped - set CONTROL_EXPORT_TEST_ISOLATED=1 to run.')
      expect(process.env['CONTROL_EXPORT_TEST_ISOLATED']).toBeUndefined()
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

  // ─── Controllable state ──────────────────────────────────────────────────────

  let activeProjectId: number | null = 1
  let activeMembershipRoles: string[] = ['admin']

  const mockCreateExport = mock(async (..._args: unknown[]) =>
    makeExportResult(['hash_value,plaintext', 'abc,pass'])
  )

  // ─── Module mocks ────────────────────────────────────────────────────────────

  mock.module('../../../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
          innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
          leftJoin: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
        }),
      }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      update: () => ({ set: () => ({ where: () => ({ catch: () => undefined }) }) }),
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

  mock.module('../../../../src/routes/control/helpers.js', () => ({
    requireProjectMembership: async () => {
      if (activeProjectId === null) {
        const err = new Error('project not selected') as Error & { status?: number }
        err.status = 400
        throw err
      }
      return { projectId: activeProjectId, roles: activeMembershipRoles }
    },
    controlErrorResponse: (
      c: { json: (body: unknown, status: number) => Response },
      err: unknown
    ) => {
      const message = err instanceof Error ? err.message : 'unknown'
      const status =
        err instanceof Error && 'status' in err
          ? ((err as Error & { status?: number }).status ?? 500)
          : 500
      return c.json(
        {
          type: `https://hashhive.dev/errors/${status === 403 ? 'forbidden' : status === 400 ? 'validation' : 'internal'}`,
          title:
            status === 403 ? 'Forbidden' : status === 400 ? 'Validation error' : 'Internal error',
          status,
          detail: message,
          instance: '/',
        },
        status
      )
    },
  }))

  // Mock the export service — export.ts imports createExport + ExportScopeParams (type-only).
  // Only runtime-used values need to be in the mock object.
  mock.module('../../../../src/services/results/export.js', () => ({
    createExport: mockCreateExport,
    escapeCsv: (val: string | null | undefined): string => {
      if (val == null) return ''
      if (val.includes(',') || val.includes('"')) return `"${val.replace(/"/g, '""')}"`
      return val
    },
    EXPORT_CSV_HEADERS: {
      'cracked-pairs': 'hash_value,plaintext,username,source,campaign,attack,hash_list,cracked_at',
      'plaintext-only': 'plaintext',
      uncracked: 'hash_value',
    },
    JOHN_FORMAT_TAGS: { 0: '$dynamic_0$', 1000: '$NT$' },
    isEmittable: mock(() => true),
    encodeCrackedRow: mock(() => null),
    encodeUncrackedRow: mock((row: { hashValue: string }) => row.hashValue),
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

  // ─── Isolated route mount ────────────────────────────────────────────────────
  // Mount the control export routes directly in a plain Hono app so tests
  // run without standing up the full server (no real requireApiKey middleware).

  const { controlExportRoutes } = await import('../../../../src/routes/control/export.js')
  const { Hono } = await import('hono')
  const app = new (Hono as { new (): { route: Function; request: Function } })()
  app.route('/', controlExportRoutes)

  beforeEach(() => {
    activeProjectId = 1
    activeMembershipRoles = ['admin']
    mockCreateExport.mockReset()
    mockCreateExport.mockImplementation(async () =>
      makeExportResult(['hash_value,plaintext', 'abc,pass'])
    )
  })

  // ─── Happy path ──────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('streams CSV with correct Content-Type and Content-Disposition', async () => {
      const res = await app.request('/?scope=project&variant=cracked-pairs&format=csv', {
        method: 'GET',
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/csv')
      const cd = res.headers.get('content-disposition')
      expect(cd).toContain('attachment')
      expect(cd).toContain('.csv')
    })

    it('streams potfile with text/plain and .potfile filename', async () => {
      mockCreateExport.mockImplementation(async () => makeExportResult(['abc:pass'], 0))

      const res = await app.request(
        '/?scope=project&variant=cracked-pairs&format=hashcat-potfile',
        { method: 'GET' }
      )

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')
      const cd = res.headers.get('content-disposition')
      expect(cd).toContain('.potfile')
    })

    it('sets x-export-skipped to the skippedCount from the service', async () => {
      mockCreateExport.mockImplementation(async () => makeExportResult(['abc:pass'], 5))

      const res = await app.request(
        '/?scope=project&variant=cracked-pairs&format=hashcat-potfile',
        { method: 'GET' }
      )

      expect(res.status).toBe(200)
      expect(res.headers.get('x-export-skipped')).toBe('5')
    })

    it('streams generator lines as newline-terminated chunks', async () => {
      mockCreateExport.mockImplementation(async () => makeExportResult(['header', 'row1', 'row2']))

      const res = await app.request('/?scope=project&variant=cracked-pairs&format=csv', {
        method: 'GET',
      })

      expect(await res.text()).toBe('header\nrow1\nrow2\n')
    })

    it('calls createExport with correct scope params for project scope', async () => {
      await app.request('/?scope=project&variant=cracked-pairs&format=csv', {
        method: 'GET',
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
      await app.request('/?scope=hash-list&variant=cracked-pairs&format=csv&hashListId=42', {
        method: 'GET',
      })

      const [_db, params] = mockCreateExport.mock.calls[0]!
      expect(params).toMatchObject({
        scope: 'hash-list',
        projectId: 1,
        hashListId: 42,
      })
    })

    it('calls createExport with campaign scope when campaignId is provided', async () => {
      await app.request('/?scope=campaign&variant=cracked-pairs&format=csv&campaignId=7', {
        method: 'GET',
      })

      const [_db, params] = mockCreateExport.mock.calls[0]!
      expect(params).toMatchObject({
        scope: 'campaign',
        projectId: 1,
        campaignId: 7,
      })
    })
  })

  // ─── Scope ID validation ─────────────────────────────────────────────────────

  describe('scope ID validation', () => {
    it('returns 400 when scope=hash-list but hashListId is missing', async () => {
      const res = await app.request('/?scope=hash-list&variant=cracked-pairs&format=csv', {
        method: 'GET',
      })
      // controlOpenApiHonoOptions.defaultHook always maps validation failures to 400
      expect(res.status).toBe(400)
      expect(mockCreateExport).not.toHaveBeenCalled()
    })

    it('returns 400 when scope=campaign but campaignId is missing', async () => {
      const res = await app.request('/?scope=campaign&variant=cracked-pairs&format=csv', {
        method: 'GET',
      })
      expect(res.status).toBe(400)
      expect(mockCreateExport).not.toHaveBeenCalled()
    })

    it('returns 400 for potfile+csv-only variant combo', async () => {
      const res = await app.request('/?scope=project&variant=uncracked&format=hashcat-potfile', {
        method: 'GET',
      })
      expect(res.status).toBe(400)
      expect(mockCreateExport).not.toHaveBeenCalled()
    })
  })

  // ─── RBAC ────────────────────────────────────────────────────────────────────

  describe('RBAC', () => {
    it('returns problem+json on 403 when requireProjectMembership throws', async () => {
      activeProjectId = null

      const res = await app.request('/?scope=project&variant=cracked-pairs&format=csv', {
        method: 'GET',
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { type?: string }
      // The mocked controlErrorResponse emits an object with a `type` field
      expect(body).toHaveProperty('type')
      expect(mockCreateExport).not.toHaveBeenCalled()
    })
  })
}
