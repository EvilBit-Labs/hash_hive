/**
 * Boot-time OpenAPI spec caching.
 *
 * `@hono/zod-openapi` regenerates the full document on every
 * `GET /openapi.json` request — there is no built-in cache. For surfaces
 * with dozens of paths and components (the dashboard surface has 44
 * paths and 50 components today) the regeneration cost is non-trivial
 * under repeated polling. In production we generate the document once
 * during app construction and serve the cached JSON string thereafter.
 *
 * In non-production environments the document is regenerated on each
 * request so hot-reloaded route definitions surface immediately during
 * development.
 */

import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Env } from 'hono'

import { env } from '../config/env.js'

type SpecConfig = Parameters<OpenAPIHono['getOpenAPI31Document']>[0]
type SpecGeneratorOpts = Parameters<OpenAPIHono['getOpenAPI31Document']>[1]

/**
 * Register a cached `GET /openapi.json` (or whatever path is supplied)
 * on the passed-in `OpenAPIHono`. In production the spec is generated
 * once on first request and served as a stable JSON string. In dev/test
 * each request regenerates so route additions are visible without a
 * restart.
 *
 * MUST be called BEFORE any auth middleware is mounted on the same app
 * — the spec endpoint is metadata that ships with the running app and
 * does not require a session.
 */
export function mountCachedSpec<E extends Env>(
  app: OpenAPIHono<E>,
  path: string,
  config: SpecConfig,
  generatorOpts?: SpecGeneratorOpts
): void {
  let cached: string | null = null

  const generate = (): string => {
    const doc = app.getOpenAPI31Document(config, generatorOpts)
    return JSON.stringify(doc)
  }

  app.get(path, (c) => {
    const body = env.NODE_ENV === 'production' ? (cached ??= generate()) : generate()
    return c.body(body, 200, { 'content-type': 'application/json; charset=utf-8' })
  })
}
