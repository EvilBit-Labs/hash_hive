/**
 * Isolated production-mode assertions for `mountCachedSpec`.
 *
 * `src/config/env.ts` captures `NODE_ENV` at module load (`export const
 * env = loadEnv()`). Mutating `process.env['NODE_ENV']` after the
 * module has been imported has no effect on the captured snapshot, so
 * the prod-cache invariants this file asserts can only be observed
 * when the preload sets `NODE_ENV='production'` BEFORE any import
 * pulls in `env.ts`.
 *
 * Run via the repo's `*_TEST_ISOLATED=1` pattern:
 *
 *   OPENAPI_SPEC_CACHE_PROD_TEST_ISOLATED=1 bun test \
 *     --preload ./tests/preload-prod.ts \
 *     tests/unit/openapi-spec-cache-prod.test.ts
 *
 * Wired into `packages/backend/package.json`'s `test` script.
 */
import { OpenAPIHono } from '@hono/zod-openapi'
import { beforeAll, describe, expect, it } from 'bun:test'

import { env } from '../../src/config/env.js'
import { registerDashboardResponseComponents } from '../../src/openapi/components.js'
import { registerDashboardSecurity } from '../../src/openapi/security.js'
import { mountCachedSpec } from '../../src/openapi/spec-cache.js'

// Mirror the repo convention used by other isolated test files
// (tests/unit/tasks.test.ts, queue-manager.test.ts, etc.): the file
// runs its assertions ONLY when invoked via its dedicated
// `OPENAPI_SPEC_CACHE_PROD_TEST_ISOLATED=1` invocation, so the
// trailing `bun test --preload ./tests/preload.ts` catch-all (which
// uses preload.ts setting NODE_ENV='test') silently no-ops on this
// file rather than fighting the env snapshot.
const isIsolated = process.env['OPENAPI_SPEC_CACHE_PROD_TEST_ISOLATED'] === '1'

describe.skipIf(!isIsolated)('mountCachedSpec (production mode, isolated)', () => {
  beforeAll(() => {
    // Hard sanity check: if this preload was not wired correctly, all
    // assertions below would silently pass against dev-mode behavior
    // (which is precisely the failure mode the reviewer flagged).
    expect(env.NODE_ENV).toBe('production')
  })

  it('generates the spec eagerly at mount time (no first-hit latency)', () => {
    const app = new OpenAPIHono()
    registerDashboardSecurity(app)
    registerDashboardResponseComponents(app)

    let generatorCalled = false
    const originalGenerator = app.getOpenAPI31Document.bind(app)
    app.getOpenAPI31Document = ((...args: Parameters<typeof originalGenerator>) => {
      generatorCalled = true
      return originalGenerator(...args)
    }) as typeof app.getOpenAPI31Document

    mountCachedSpec(app, '/openapi.json', {
      openapi: '3.1.0',
      info: { title: 'Dashboard', version: '1' },
    })

    // In production, generation runs inside mountCachedSpec — BEFORE
    // any request hits the endpoint.
    expect(generatorCalled).toBe(true)
  })

  it('returns identical bytes across two successive requests', async () => {
    const app = new OpenAPIHono()
    registerDashboardSecurity(app)
    registerDashboardResponseComponents(app)
    mountCachedSpec(app, '/openapi.json', {
      openapi: '3.1.0',
      info: { title: 'Stable', version: '1' },
    })

    const res1 = await app.request('/openapi.json')
    const res2 = await app.request('/openapi.json')
    const body1 = await res1.text()
    const body2 = await res2.text()

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(body1).toBe(body2)
  })

  it('does not call the generator a second time on a follow-up request (cache hit)', async () => {
    const app = new OpenAPIHono()
    registerDashboardSecurity(app)
    registerDashboardResponseComponents(app)

    let generatorCallCount = 0
    const originalGenerator = app.getOpenAPI31Document.bind(app)
    app.getOpenAPI31Document = ((...args: Parameters<typeof originalGenerator>) => {
      generatorCallCount += 1
      return originalGenerator(...args)
    }) as typeof app.getOpenAPI31Document

    mountCachedSpec(app, '/openapi.json', {
      openapi: '3.1.0',
      info: { title: 'Dashboard', version: '1' },
    })

    // Generator runs ONCE during mountCachedSpec (eager prod cache).
    expect(generatorCallCount).toBe(1)

    await app.request('/openapi.json')
    await app.request('/openapi.json')
    await app.request('/openapi.json')

    // No additional generator calls under prod (cached string served).
    expect(generatorCallCount).toBe(1)
  })
})
