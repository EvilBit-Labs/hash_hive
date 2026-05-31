import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
/**
 * Compatibility spike for `@hono/zod-openapi` against the repo's pinned
 * Zod v4 and Hono v4.12.x. Validates the framework features the
 * migration plan in
 * `docs/plans/2026-05-31-001-feat-openapi-auto-generation-migration-plan.md`
 * depends on, BEFORE U2-U7 commit to using them.
 *
 * Each test below maps to a Test Scenario under "U1. Compatibility spike"
 * in the plan. If any of these break in a future library bump, the
 * migration's assumptions need re-verification.
 *
 * **Retention rationale.** Kept as a permanent regression smoke for the
 * compatibility assumptions U2-U7 depend on, not removed at U1 close.
 * Cost is negligible (no network, no DB, no app boot — pure schema/spec
 * assertions) and the signal value on a future `@hono/zod-openapi` or
 * Zod upgrade is high: a failure here means a migration assumption
 * (`oneOf` emission, `$ref` escape hatch, security-scheme round-trip,
 * sub-app registry merging, literal preservation) has shifted under the
 * route layer and warrants re-verification before downstream behavior
 * changes.
 */
import { describe, expect, it } from 'bun:test'

// ─── Helpers ──────────────────────────────────────────────────────────

type OpenAPIDocument = {
  openapi: string
  info: { title: string; version: string }
  paths: Record<string, Record<string, unknown>>
  components?: {
    schemas?: Record<string, unknown>
    responses?: Record<string, unknown>
    securitySchemes?: Record<string, unknown>
  }
}

function buildEmptyApp(): OpenAPIHono {
  return new OpenAPIHono()
}

function generateDoc(app: OpenAPIHono): OpenAPIDocument {
  return app.getOpenAPI31Document(
    {
      openapi: '3.1.0',
      info: { title: 'Spike API', version: '1.0.0' },
    },
    // The generator option that maps discriminated unions onto `oneOf`
    // rather than `anyOf` — required for parity with the agent surface's
    // current hand-rolled YAML (10 `oneOf` occurrences in
    // packages/openapi/agent-api.yaml). Locked in by plan D5.
    { unionPreferredType: 'oneOf' }
  ) as OpenAPIDocument
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('@hono/zod-openapi compatibility spike (U1)', () => {
  it('round-trips the supplied 3.1 document config and shapes a paths object', () => {
    const app = buildEmptyApp()

    const doc = generateDoc(app)

    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info.title).toBe('Spike API')
    expect(doc.info.version).toBe('1.0.0')
    // `paths` is required by the OpenAPI 3.1 spec; an empty object is
    // valid for a router with no registered routes. Asserting the
    // typeof guards against future generator versions that might omit
    // the key entirely on empty input.
    expect(typeof doc.paths).toBe('object')
    expect(doc.paths).not.toBeNull()
  })

  it('emits `oneOf` (not `anyOf`) for a Zod discriminated union when generator is configured', () => {
    // Mirrors the agent surface's task-report shape: discriminated union
    // on a `status` literal. The plan's D5 requires `oneOf` output to
    // match agent-api.yaml's current shape.
    const successVariant = z.object({
      status: z.literal('success'),
      crackedCount: z.number().int().nonnegative(),
    })
    const failureVariant = z.object({
      status: z.literal('failure'),
      errorMessage: z.string(),
    })
    const taskReportSchema = z
      .discriminatedUnion('status', [successVariant, failureVariant])
      .openapi('TaskReport', {
        discriminator: { propertyName: 'status' },
      })

    const route = createRoute({
      method: 'post',
      path: '/tasks/{id}/report',
      request: {
        params: z.object({ id: z.string() }),
        body: {
          content: {
            'application/json': { schema: taskReportSchema },
          },
        },
      },
      responses: {
        204: { description: 'reported' },
      },
    })

    const app = buildEmptyApp()
    app.openapi(route, (c) => c.body(null, 204))

    const doc = generateDoc(app)
    const reportSchema = doc.components?.schemas?.['TaskReport'] as
      | { oneOf?: unknown[]; anyOf?: unknown[]; discriminator?: { propertyName: string } }
      | undefined

    expect(reportSchema).toBeDefined()
    expect(Array.isArray(reportSchema?.oneOf)).toBe(true)
    expect(reportSchema?.oneOf?.length).toBe(2)
    expect(reportSchema?.anyOf).toBeUndefined()
    expect(reportSchema?.discriminator?.propertyName).toBe('status')
  })

  it('registers a named component via `.openapi("Name")` and references it via $ref', () => {
    const userSchema = z
      .object({
        id: z.string(),
        email: z.string(),
      })
      .openapi('User')

    const route = createRoute({
      method: 'get',
      path: '/users/{id}',
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: userSchema } },
        },
      },
    })

    const app = buildEmptyApp()
    app.openapi(route, (c) => c.json({ id: c.req.valid('param').id, email: 'a@b' }, 200))

    const doc = generateDoc(app)
    expect(doc.components?.schemas?.['User']).toBeDefined()

    const responseSchema = doc.paths['/users/{id}']?.['get'] as {
      responses: { '200': { content: { 'application/json': { schema: { $ref?: string } } } } }
    }
    const ref = responseSchema.responses['200'].content['application/json'].schema.$ref
    expect(ref).toBe('#/components/schemas/User')
  })

  it('registers a shared response component and references it via $ref escape hatch', () => {
    // Mirrors AuthRequired/Forbidden/ValidationFailed/ResourceNotFound
    // pattern used across all three hand-rolled YAMLs (e.g.
    // packages/openapi/dashboard-api.yaml lines 155, 194, 224, etc.).
    // Plan D6 locks in this exact mechanism.
    const errorSchema = z.object({
      error: z.object({
        code: z.string(),
        message: z.string(),
      }),
    })

    const app = buildEmptyApp()
    app.openAPIRegistry.registerComponent('responses', 'AuthRequired', {
      description: 'Authentication required',
      content: { 'application/json': { schema: errorSchema } },
    })

    const route = createRoute({
      method: 'get',
      path: '/protected',
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
        },
        // The documented escape hatch: the route type expects an inline
        // response definition; the `as any` cast is the library's
        // sanctioned way to reference a registered shared response.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        401: { $ref: '#/components/responses/AuthRequired' } as any,
      },
    })
    app.openapi(route, (c) => c.json({ ok: true }, 200))

    const doc = generateDoc(app)
    expect(doc.components?.responses?.['AuthRequired']).toBeDefined()

    const protectedRoute = doc.paths['/protected']?.['get'] as {
      responses: Record<string, { $ref?: string }>
    }
    expect(protectedRoute.responses['401'].$ref).toBe('#/components/responses/AuthRequired')
  })

  it('registers security schemes per-surface and references them from createRoute', () => {
    // Plan D8 — each of the three surfaces (dashboard cookie, control
    // API key, agent Bearer) registers its scheme on its own
    // OpenAPIHono registry. Verify each shape round-trips.
    const app = buildEmptyApp()
    app.openAPIRegistry.registerComponent('securitySchemes', 'Cookie', {
      type: 'apiKey',
      in: 'cookie',
      name: 'better-auth.session_token',
    })
    app.openAPIRegistry.registerComponent('securitySchemes', 'ApiKey', {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    })
    app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
      type: 'http',
      scheme: 'bearer',
    })

    // One route per scheme so all three schemes are round-tripped
    // through `security: [...]` — U5 (control) wires ApiKey, U6 (agent)
    // wires Bearer; verify both work end-to-end at U1, not just at
    // registration time.
    const cookieRoute = createRoute({
      method: 'get',
      path: '/dashboard/me',
      security: [{ Cookie: [] }],
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: z.object({ id: z.string() }) } },
        },
      },
    })
    const apiKeyRoute = createRoute({
      method: 'get',
      path: '/control/me',
      security: [{ ApiKey: [] }],
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: z.object({ id: z.string() }) } },
        },
      },
    })
    const bearerRoute = createRoute({
      method: 'get',
      path: '/agent/me',
      security: [{ Bearer: [] }],
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: z.object({ id: z.string() }) } },
        },
      },
    })
    app.openapi(cookieRoute, (c) => c.json({ id: '1' }, 200))
    app.openapi(apiKeyRoute, (c) => c.json({ id: '2' }, 200))
    app.openapi(bearerRoute, (c) => c.json({ id: '3' }, 200))

    const doc = generateDoc(app)
    const schemes = doc.components?.securitySchemes
    // `toMatchObject` over `toEqual` so a future generator that adds
    // benign metadata (e.g. `description`, `bearerFormat`) does not
    // break the assertion. Semantic regression — a changed `type`,
    // `in`, or `name` — would still fail.
    expect(schemes?.['Cookie']).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'better-auth.session_token',
    })
    expect(schemes?.['ApiKey']).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    })
    expect(schemes?.['Bearer']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    })

    const meRoute = doc.paths['/dashboard/me']?.['get'] as {
      security?: Array<Record<string, string[]>>
    }
    const controlMeRoute = doc.paths['/control/me']?.['get'] as {
      security?: Array<Record<string, string[]>>
    }
    const agentMeRoute = doc.paths['/agent/me']?.['get'] as {
      security?: Array<Record<string, string[]>>
    }
    expect(meRoute.security).toEqual([{ Cookie: [] }])
    expect(controlMeRoute.security).toEqual([{ ApiKey: [] }])
    expect(agentMeRoute.security).toEqual([{ Bearer: [] }])
  })

  it('preserves z.literal narrowing in the generated request body schema', () => {
    // Plan U1 test scenario — confirms the literal narrowing the agent
    // surface relies on (e.g. error code unions) is preserved through
    // spec generation.
    const cancelRequestSchema = z
      .object({
        action: z.literal('cancel'),
        reason: z.string().min(1),
      })
      .openapi('CancelRequest')

    const route = createRoute({
      method: 'post',
      path: '/cancel',
      request: {
        body: {
          content: { 'application/json': { schema: cancelRequestSchema } },
        },
      },
      responses: {
        204: { description: 'cancelled' },
      },
    })

    const app = buildEmptyApp()
    app.openapi(route, (c) => c.body(null, 204))

    const doc = generateDoc(app)
    const cancelSchema = doc.components?.schemas?.['CancelRequest'] as {
      properties?: { action?: { const?: string; type?: string; enum?: string[] } }
      required?: string[]
    }
    const actionProp = cancelSchema?.properties?.action
    // OpenAPI 3.1 expresses a literal as either `const: "cancel"` or
    // `enum: ["cancel"]` depending on the generator's version. Accept
    // either as long as the narrowing survives.
    const preservesLiteral =
      actionProp?.const === 'cancel' ||
      (Array.isArray(actionProp?.enum) &&
        actionProp.enum.length === 1 &&
        actionProp.enum[0] === 'cancel')
    expect(preservesLiteral).toBe(true)
    expect(cancelSchema?.required).toContain('action')
    expect(cancelSchema?.required).toContain('reason')
  })

  it('merges nested sub-app routes and components into the parent spec (plan D1)', () => {
    // Plan D1 / U2's dashboard aggregator both depend on this: mounting
    // an OpenAPIHono child via `parent.route('/prefix', child)` exposes
    // the child's routes and components on the parent's generated spec.
    // The plan keeps the top-level `app` in `packages/backend/src/index.ts`
    // as plain Hono precisely BECAUSE this merging happens — verify the
    // merge actually works so the dashboard aggregator pattern in U2 is
    // sound before any route migration commits to it.
    const widgetSchema = z
      .object({
        id: z.string(),
        label: z.string(),
      })
      .openapi('Widget')

    const widgetsRoute = createRoute({
      method: 'get',
      path: '/widgets',
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: widgetSchema } },
        },
      },
    })

    const child = buildEmptyApp()
    child.openapi(widgetsRoute, (c) => c.json({ id: '1', label: 'w' }, 200))

    const parent = buildEmptyApp()
    parent.route('/dashboard', child)

    const doc = generateDoc(parent)

    // (a) the child route surfaces under the parent's prefix
    expect(doc.paths['/dashboard/widgets']).toBeDefined()
    expect(doc.paths['/dashboard/widgets']?.['get']).toBeDefined()

    // (b) the child's named component lifts into the parent's components
    expect(doc.components?.schemas?.['Widget']).toBeDefined()

    // (c) the parent route references the component at the parent-level
    // path (not a sub-app-scoped ref) so $ref resolution stays valid
    // across surface boundaries
    const widgetsResponseSchema = doc.paths['/dashboard/widgets']?.['get'] as {
      responses: { '200': { content: { 'application/json': { schema: { $ref?: string } } } } }
    }
    const widgetRef = widgetsResponseSchema.responses['200'].content['application/json'].schema.$ref
    expect(widgetRef).toBe('#/components/schemas/Widget')
  })
})
