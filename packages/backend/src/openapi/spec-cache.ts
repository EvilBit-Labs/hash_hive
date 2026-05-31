/**
 * OpenAPI spec serving with boot-time caching in production.
 *
 * `@hono/zod-openapi` regenerates the full document on every
 * `GET /openapi.json` request. For surfaces with dozens of paths and
 * components the regeneration cost is non-trivial under repeated
 * polling, so production generates the document once at mount time
 * and serves the cached JSON string thereafter.
 *
 * In non-production environments the document is regenerated on each
 * request so hot-reloaded route definitions surface immediately during
 * development.
 *
 * Generation runs eagerly in production at `mountCachedSpec` call time
 * so a malformed Zod schema (cyclic `$ref`, missing `.openapi()` label,
 * etc.) fails the app at boot rather than at first client poll.
 * Generation failure is logged with a stable errorId and the spec
 * endpoint serves a typed dashboard error envelope so monitoring picks
 * it up immediately.
 */

import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Env } from 'hono'

import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

type SpecConfig = Parameters<OpenAPIHono['getOpenAPI31Document']>[0]
type SpecGeneratorOpts = Parameters<OpenAPIHono['getOpenAPI31Document']>[1]

const OPENAPI_SPEC_FAILURE_BODY = JSON.stringify({
  error: {
    code: 'OPENAPI_SPEC_GENERATION_FAILED',
    message:
      'The OpenAPI spec for this surface could not be generated. This indicates a backend route definition is malformed; check the backend logs for the underlying error.',
  },
})

/**
 * Register a cached `GET /openapi.json` (or whatever path is supplied)
 * on the passed-in `OpenAPIHono`.
 *
 * MUST be called BEFORE any auth middleware is mounted on the same app,
 * or the spec endpoint will 401 anonymously and break client codegen
 * tooling and Swagger UI integrations.
 *
 * Production behavior: the document is generated once at this call
 * (eager boot-time validation; a malformed schema fails boot, not the
 * first poll). If generation throws, the failure is logged and the
 * endpoint serves a 500 with the dashboard error envelope on every
 * subsequent request until the underlying defect is fixed and the app
 * restarts.
 *
 * Dev / test behavior: the document is regenerated on each request so
 * route additions surface without a restart. Throws still bubble to
 * Hono's onError as before — the eager cache only applies in prod.
 */
export function mountCachedSpec<E extends Env>(
  app: OpenAPIHono<E>,
  path: string,
  config: SpecConfig,
  generatorOpts?: SpecGeneratorOpts
): void {
  const isProduction = env.NODE_ENV === 'production'

  let cached: string | null = null
  let cacheFailed = false

  if (isProduction) {
    try {
      cached = JSON.stringify(app.getOpenAPI31Document(config, generatorOpts))
    } catch (err) {
      cacheFailed = true
      logger.error(
        { err, specPath: path, errorId: 'OPENAPI_SPEC_GENERATION_FAILED' },
        'OpenAPI spec generation failed at mount time; serving 500 on every poll until the underlying defect is fixed and the app restarts'
      )
    }
  }

  app.get(path, (c) => {
    if (isProduction) {
      if (cacheFailed || cached === null) {
        return c.body(OPENAPI_SPEC_FAILURE_BODY, 500, {
          'content-type': 'application/json; charset=utf-8',
        })
      }
      return c.body(cached, 200, { 'content-type': 'application/json; charset=utf-8' })
    }

    // Dev / test: regenerate per request so hot-reloaded routes appear
    // immediately. Errors propagate to Hono's onError handler — they
    // surface during local development rather than getting swallowed.
    const body = JSON.stringify(app.getOpenAPI31Document(config, generatorOpts))
    return c.body(body, 200, { 'content-type': 'application/json; charset=utf-8' })
  })
}
