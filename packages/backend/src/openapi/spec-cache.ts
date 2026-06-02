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

/**
 * Surface-specific failure envelope. Default is the dashboard-shaped
 * `{ error: { code, message } }`. The control surface passes an RFC
 * 9457 problem-details body via the `mountCachedSpec` `failureEnvelope`
 * option so a 500 from `/api/v1/control/openapi.json` matches the
 * surface's documented error contract instead of leaking the
 * dashboard envelope into a problem-details client SDK.
 */
export interface SpecFailureEnvelope {
  body: string
  contentType: string
}

const DASHBOARD_FAILURE_ENVELOPE: SpecFailureEnvelope = {
  body: JSON.stringify({
    error: {
      code: 'OPENAPI_SPEC_GENERATION_FAILED',
      message:
        'The OpenAPI spec for this surface could not be generated. This indicates a backend route definition is malformed; check the backend logs for the underlying error.',
    },
  }),
  contentType: 'application/json; charset=utf-8',
}

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
 * endpoint serves a 500 with the caller-supplied failure envelope
 * (defaults to the dashboard `{ error: { code, message } }` shape;
 * pass a problem-details envelope via `opts.failureEnvelope` for the
 * control surface) on every subsequent request until the underlying
 * defect is fixed and the app restarts.
 *
 * Dev / test behavior: the document is regenerated on each request so
 * route additions surface without a restart. Throws still bubble to
 * Hono's onError as before — the eager cache only applies in prod.
 */
export function mountCachedSpec<E extends Env>(
  app: OpenAPIHono<E>,
  path: string,
  config: SpecConfig,
  opts: {
    generatorOpts?: SpecGeneratorOpts
    failureEnvelope?: SpecFailureEnvelope
  } = {}
): void {
  const isProduction = env.NODE_ENV === 'production'
  const failure = opts.failureEnvelope ?? DASHBOARD_FAILURE_ENVELOPE
  const successContentType = 'application/json; charset=utf-8'

  let cached: string | null = null
  let cacheFailed = false

  if (isProduction) {
    try {
      cached = JSON.stringify(app.getOpenAPI31Document(config, opts.generatorOpts))
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
        return c.body(failure.body, 500, { 'content-type': failure.contentType })
      }
      return c.body(cached, 200, { 'content-type': successContentType })
    }

    // Dev / test: regenerate per request so hot-reloaded routes appear
    // immediately. Errors propagate to Hono's onError handler — they
    // surface during local development rather than getting swallowed.
    const body = JSON.stringify(app.getOpenAPI31Document(config, opts.generatorOpts))
    return c.body(body, 200, { 'content-type': successContentType })
  })
}
