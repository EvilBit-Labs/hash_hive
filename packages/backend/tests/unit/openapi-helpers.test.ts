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
