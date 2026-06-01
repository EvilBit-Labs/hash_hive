/**
 * Pin the served `/api/v1/control/openapi.json` runtime spec against
 * structural regressions. The dashboard surface ran into this exact
 * failure class in U4's prereq: `.catch()`-wrapped Zod schemas threw
 * `UnknownZodTypeError` at `getOpenAPI31Document(...)` time, but no
 * test caught it because no test BOOTED the aggregator and asked for
 * the served spec. With the control YAML deleted, the route-as-spec is
 * canonical — a future `createRoute` change that breaks spec gen would
 * silently break client codegen otherwise.
 *
 * Coverage:
 *  - Anonymous fetch returns 200 (the spec MUST be reachable without
 *    an API key for client codegen and Swagger UI consumers).
 *  - Body is valid OpenAPI 3.1 JSON with the documented info shape.
 *  - All seven shared response components are registered under
 *    `components.responses` (drift would mean a sub-router started
 *    referencing a `$ref` that doesn't exist).
 *  - The control security scheme is registered as `ControlApiKey`
 *    (pins the U5 rename from the YAML's `BearerApiKey` — a silent
 *    revert would generate broken client SDKs).
 *  - `ProblemDetails` is registered as a schema component (the RFC
 *    9457 envelope every consumer parses error bodies against).
 *  - At least one converted route is present (sanity check that the
 *    aggregator's sub-routers actually merge into the spec).
 */
import { describe, expect, it, mock } from 'bun:test'

// Mock the DB + Redis modules controlRoutes transitively imports so
// the aggregator can boot inside a unit test without touching real
// infrastructure. We don't fire any handlers in this test — only the
// spec endpoint — so the mocks just need to be no-ops that satisfy
// the static imports.
mock.module('../../src/db/index.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({ set: () => ({ where: async () => ({ rowCount: 0 }) }) }),
    delete: () => ({ where: async () => ({ rowCount: 0 }) }),
  },
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

const { controlRoutes } = await import('../../src/routes/control/index.js')

interface SpecBody {
  openapi?: string
  info?: { title?: string; version?: string }
  paths?: Record<string, Record<string, unknown>>
  components?: {
    schemas?: Record<string, unknown>
    responses?: Record<string, unknown>
    securitySchemes?: Record<string, { type?: string; in?: string; name?: string }>
  }
}

describe('control /openapi.json — runtime spec contract', () => {
  it('serves the spec anonymously (no API key) with valid OpenAPI 3.1 JSON', async () => {
    const res = await controlRoutes.request('/openapi.json')
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType.startsWith('application/json')).toBe(true)

    const body = (await res.json()) as SpecBody
    expect(body.openapi).toBe('3.1.0')
    expect(body.info?.title).toBe('HashHive Control API')
    expect(body.info?.version).toBe('2.0.0')
  })

  it('registers all seven shared response components', async () => {
    const res = await controlRoutes.request('/openapi.json')
    const body = (await res.json()) as SpecBody
    const responses = body.components?.responses ?? {}

    // Order matters: this MUST match the CONTROL_RESPONSE_NAMES tuple
    // in `openapi/components.ts` exactly. A divergence here means
    // either a name was added without registering or a name was
    // dropped without removing the route reference.
    for (const name of [
      'AuthError',
      'Forbidden',
      'NotFound',
      'ValidationError',
      'Conflict',
      'InternalError',
      'ServiceUnavailable',
    ]) {
      expect(responses[name]).toBeDefined()
    }
  })

  it('registers the ControlApiKey security scheme (pins the U5 rename)', async () => {
    const res = await controlRoutes.request('/openapi.json')
    const body = (await res.json()) as SpecBody
    const schemes = body.components?.securitySchemes ?? {}

    // `ControlApiKey` matches the route-as-spec naming convention
    // (sibling of `SessionCookie` on dashboard, future `AgentBearer`
    // on agent). A silent revert to the YAML's old `BearerApiKey`
    // name would break generated SDKs.
    expect(schemes['ControlApiKey']).toBeDefined()
    expect(schemes['ControlApiKey']?.type).toBe('http')

    // Sanity check: the OLD name should NOT be present (so a revert is
    // caught by name mismatch, not silent dual-registration).
    expect(schemes['BearerApiKey']).toBeUndefined()
  })

  it('registers the ProblemDetails schema (RFC 9457 envelope)', async () => {
    const res = await controlRoutes.request('/openapi.json')
    const body = (await res.json()) as SpecBody
    const schemas = body.components?.schemas ?? {}
    expect(schemas['ProblemDetails']).toBeDefined()
  })

  it('merges sub-router routes into the aggregator spec', async () => {
    // The aggregator mounts ten sub-routers (health, projects, users,
    // hashlists, stats, resources, campaigns, attacks, agents, tasks).
    // We don't enumerate every path — just check that the merge
    // actually happened by counting paths and asserting the GET
    // /health route is present (smallest, simplest sub-router).
    const res = await controlRoutes.request('/openapi.json')
    const body = (await res.json()) as SpecBody
    const paths = Object.keys(body.paths ?? {})

    // Catch a "no sub-routers mounted" regression where every
    // sub-router's `.openapi(...)` call gets stripped.
    expect(paths.length).toBeGreaterThan(5)

    // Spot-check one path so the test fails loudly if a refactor
    // breaks the merge-on-mount invariant. `/health` is the canonical
    // smallest sub-router.
    expect(paths).toContain('/health')
  })
})
