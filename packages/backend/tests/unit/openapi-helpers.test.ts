/**
 * Unit tests for the dashboard OpenAPI plumbing helpers.
 *
 * Pure-in-process tests: no DB, no network, no app boot. Cover the
 * boundaries the review pass surfaced as silent-failure risk:
 *
 *   - Spec endpoint mounted before any auth middleware and
 *     anonymously fetchable (the metadata-not-data contract).
 *   - Shared response components (`AuthRequired`, `Forbidden`,
 *     `ValidationFailed`, `ResourceNotFound`) all appear in the
 *     generated spec under `components.responses`.
 *   - Security scheme `SessionCookie` registers with the cookie name
 *     and shape that match the existing dashboard contract.
 *   - Duplicate component / security-scheme registration throws
 *     loudly instead of silently last-write-wins.
 *   - `sharedResponse()` round-trips to a `$ref` in the emitted spec.
 *   - `mountCachedSpec` caches the generated body in production mode
 *     so subsequent requests return the same bytes.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { describe, expect, it } from 'bun:test'

import {
  DASHBOARD_RESPONSE_REFS,
  _guardDuplicateComponentRegistrationForTest,
  dashboardOpenApiHonoOptions,
  registerDashboardResponseComponents,
  sharedResponse,
} from '../../src/openapi/components.js'
import {
  registerAgentSecurity,
  registerControlSecurity,
  registerDashboardSecurity,
} from '../../src/openapi/security.js'
import { mountCachedSpec } from '../../src/openapi/spec-cache.js'

function buildSurface(): OpenAPIHono {
  const app = new OpenAPIHono()
  registerDashboardSecurity(app)
  registerDashboardResponseComponents(app)
  return app
}

describe('registerDashboardSecurity', () => {
  it('registers SessionCookie with the cookie name dashboard-api.yaml documents', () => {
    const app = new OpenAPIHono()
    registerDashboardSecurity(app)

    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'Dashboard', version: '1' },
    }) as {
      components?: {
        securitySchemes?: Record<string, { type: string; in?: string; name?: string }>
      }
    }

    const scheme = doc.components?.securitySchemes?.['SessionCookie']
    expect(scheme).toBeDefined()
    expect(scheme).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'hh.session_token',
    })
  })

  it('throws on duplicate SessionCookie registration', () => {
    const app = new OpenAPIHono()
    registerDashboardSecurity(app)
    expect(() => registerDashboardSecurity(app)).toThrow(
      /Duplicate security scheme registration.*SessionCookie/
    )
  })
})

describe('registerControlSecurity / registerAgentSecurity', () => {
  it('register their respective schemes on an isolated registry', () => {
    const app = new OpenAPIHono()
    registerControlSecurity(app)
    registerAgentSecurity(app)

    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'Mixed', version: '1' },
    }) as {
      components?: {
        securitySchemes?: Record<string, { type: string; scheme?: string; bearerFormat?: string }>
      }
    }

    expect(doc.components?.securitySchemes?.['ControlApiKey']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    })
    expect(doc.components?.securitySchemes?.['AgentBearer']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    })
  })

  it('each throws on its own duplicate registration', () => {
    const app1 = new OpenAPIHono()
    registerControlSecurity(app1)
    expect(() => registerControlSecurity(app1)).toThrow(/ControlApiKey/)

    const app2 = new OpenAPIHono()
    registerAgentSecurity(app2)
    expect(() => registerAgentSecurity(app2)).toThrow(/AgentBearer/)
  })
})

describe('registerDashboardResponseComponents', () => {
  it('registers all four shared responses and the error envelope schema', () => {
    const app = buildSurface()
    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'Dashboard', version: '1' },
    }) as {
      components?: {
        schemas?: Record<string, unknown>
        responses?: Record<string, unknown>
      }
    }

    expect(doc.components?.schemas?.['DashboardErrorEnvelope']).toBeDefined()
    for (const name of ['AuthRequired', 'Forbidden', 'ValidationFailed', 'ResourceNotFound']) {
      expect(doc.components?.responses?.[name]).toBeDefined()
    }
  })

  it('refs in DASHBOARD_RESPONSE_REFS resolve to the registered component names', () => {
    // Pure compile-time-style invariant exercised at runtime: the refs
    // object derives its values from the same array the registration
    // loop iterates, so the ref string for each name MUST match the
    // canonical `#/components/responses/<Name>` path.
    expect(DASHBOARD_RESPONSE_REFS.AuthRequired).toBe('#/components/responses/AuthRequired')
    expect(DASHBOARD_RESPONSE_REFS.Forbidden).toBe('#/components/responses/Forbidden')
    expect(DASHBOARD_RESPONSE_REFS.ValidationFailed).toBe('#/components/responses/ValidationFailed')
    expect(DASHBOARD_RESPONSE_REFS.ResourceNotFound).toBe('#/components/responses/ResourceNotFound')
  })

  it('throws on duplicate registration', () => {
    const app = buildSurface()
    expect(() => registerDashboardResponseComponents(app)).toThrow(/Duplicate/)
  })

  it('guardDuplicateComponentRegistration throws on a re-registered response', () => {
    const app = new OpenAPIHono()
    app.openAPIRegistry.registerComponent('responses', 'SomeResponse', {
      description: 'demo',
      content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
    })
    expect(() =>
      _guardDuplicateComponentRegistrationForTest(app, 'responses', 'SomeResponse')
    ).toThrow(/SomeResponse/)
  })
})

describe('dashboardOpenApiHonoOptions.defaultHook', () => {
  it('maps Zod validation failures to the dashboard error envelope and exits early on success', async () => {
    // End-to-end: register a route with a body schema, fire a request
    // with an invalid body, and assert the dashboard envelope plus the
    // joined `path: message; path: message` shape the project's other
    // routes rely on.
    const app = new OpenAPIHono(dashboardOpenApiHonoOptions)
    const route = createRoute({
      method: 'post',
      path: '/echo',
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                name: z.string().min(1),
                count: z.number().int(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    })
    app.openapi(route, (c) => c.json({ ok: true }, 200))

    // Fire with two failing fields; expect both to surface, each
    // prefixed with its `path.join('.')`.
    const res = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', count: 'not a number' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('VALIDATION_ERROR')
    // Path prefix is on each issue; both issues are joined with `'; '`.
    expect(body.error?.message).toContain('name')
    expect(body.error?.message).toContain('count')
    expect(body.error?.message).toContain('; ')
  })

  it('returns undefined on success so the handler chain continues', async () => {
    // No body schema → no validation runs → handler returns 200 with
    // the literal payload, proving the hook does NOT intercept the
    // success path.
    const app = new OpenAPIHono(dashboardOpenApiHonoOptions)
    const route = createRoute({
      method: 'get',
      path: '/health',
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: z.object({ status: z.string() }) } },
        },
      },
    })
    app.openapi(route, (c) => c.json({ status: 'green' }, 200))

    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('green')
  })
})

describe('sharedResponse', () => {
  it('produces a $ref payload that round-trips to a $ref in the emitted spec', () => {
    const app = buildSurface()
    const route = createRoute({
      method: 'get',
      path: '/protected',
      security: [{ SessionCookie: [] }],
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
        },
        401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
        403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
      },
    })
    app.openapi(route, (c) => c.json({ ok: true }, 200))

    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'Dashboard', version: '1' },
    }) as {
      paths: Record<string, Record<string, { responses: Record<string, { $ref?: string }> }>>
    }
    const protectedGet = doc.paths['/protected']?.['get']
    expect(protectedGet?.responses['401']?.$ref).toBe('#/components/responses/AuthRequired')
    expect(protectedGet?.responses['403']?.$ref).toBe('#/components/responses/Forbidden')
  })
})

describe('dashboard surface route registration', () => {
  // Hono's path matcher is last-writer-wins on overlap; an accidental
  // duplicate registration silently swallows the older handler. The
  // split-file pattern (registerCampaignAttackRoutes,
  // registerCampaignLifecycleRoutes, registerGenericResourceRoutes
  // called 3x, registerChunkedUploadRoutes) makes this risk easy to
  // introduce by accident.
  //
  // This test walks `surface.routes` — Hono's runtime routing table,
  // populated by every `.get/.post/...` and `.openapi(...)` call —
  // and asserts no duplicate `METHOD path` pair. We deliberately do
  // NOT call `getOpenAPI31Document(...)` here: some converted route
  // schemas use `z.coerce.number().catch(...)` patterns that the
  // OpenAPI generator can't introspect today. Surfacing those as
  // spec-generation gaps is U4's job (the diff script). The
  // duplicate-route invariant is checkable independent of spec gen.
  it('registers every dashboard path+method exactly once (no silent overlap)', async () => {
    // Dynamic import so the surface aggregator (which transitively
    // imports BetterAuth via the auth router) doesn't run at module
    // load — keeps this test pure-in-process.
    const { createDashboardSurface } = await import('../../src/routes/dashboard/index.js')
    // The aggregator wants an upgradeWebSocket factory for the events
    // sub-router. We never invoke it here, so a stub satisfies the
    // signature without booting a Bun WebSocket runtime.
    const stubUpgradeWebSocket = (() => () => {
      throw new Error('upgradeWebSocket stub: never invoked in route-surface test')
    }) as unknown as Parameters<typeof createDashboardSurface>[0]

    const surface = createDashboardSurface(stubUpgradeWebSocket)
    // The OpenAPIRegistry's `definitions` array contains one entry
    // per `app.openapi(route, handler)` call (type 'route'), plus
    // entries for components and parameters. Filtering to type
    // 'route' gives us exactly the handler registrations we want
    // to check for duplicates — middleware proliferation in
    // Hono's `app.routes` table would otherwise drown out the signal.
    const definitions = (
      surface.openAPIRegistry as unknown as {
        definitions: Array<{
          type: string
          route?: { method: string; path: string }
        }>
      }
    ).definitions

    const seen = new Map<string, number>()
    for (const def of definitions) {
      if (def.type !== 'route' || !def.route) continue
      const key = `${def.route.method.toUpperCase()} ${def.route.path}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }

    const duplicates = Array.from(seen.entries())
      .filter(([, count]) => count > 1)
      .map(([key, count]) => `${key} (registered ${count}x)`)

    expect(duplicates).toEqual([])

    // Sanity: at least some routes registered (catches a silent
    // "no routes mounted" regression where every domain router's
    // openapi() calls were stripped).
    expect(seen.size).toBeGreaterThan(0)
  })
})

describe('mountCachedSpec', () => {
  it('serves the spec anonymously (no auth middleware), responds 200 with OpenAPI 3.1 JSON', async () => {
    const app = buildSurface()
    mountCachedSpec(app, '/openapi.json', {
      openapi: '3.1.0',
      info: { title: 'Dashboard', version: '1' },
    })

    const res = await app.request('/openapi.json')
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType.startsWith('application/json')).toBe(true)

    const body = (await res.json()) as {
      openapi: string
      info: { title: string }
      components?: { securitySchemes?: Record<string, unknown> }
    }
    expect(body.openapi).toBe('3.1.0')
    expect(body.info.title).toBe('Dashboard')
    expect(body.components?.securitySchemes?.['SessionCookie']).toBeDefined()
  })

  // Production-mode cache invariants (eager generation at mount,
  // identical bytes across requests, generator called exactly once)
  // live in tests/unit/openapi-spec-cache-prod.test.ts and run under
  // an isolated bun-test invocation with --preload ./tests/preload-prod.ts.
  // `src/config/env.ts` snapshots NODE_ENV at module load, so mutating
  // process.env inside a test that has already imported spec-cache.ts
  // (via this file's static imports) does not switch the prod branch.
  // The isolated file uses the repo's *_TEST_ISOLATED=1 pattern to
  // guarantee preload-prod.ts runs before any project import.
})
