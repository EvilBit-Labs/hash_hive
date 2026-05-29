import { describe, expect, it } from 'bun:test'
/**
 * CQ-H2: dashboardError helper unit tests.
 *
 * The helper itself is thin (status + code + message -> envelope) but
 * codifies a load-bearing contract: every dashboard route's error
 * response uses the shape `{ error: { code, message } }` and the code
 * comes from the DashboardErrorCode union exported from `@hashhive/shared`.
 */
import { Hono } from 'hono'

import type { AppEnv } from '../../../src/types.js'

import { dashboardError } from '../../../src/lib/dashboard-errors.js'

describe('dashboardError', () => {
  it('emits the standard envelope shape', async () => {
    const app = new Hono<AppEnv>()
    app.get('/x', (c) => dashboardError(c, 400, 'VALIDATION_ERROR', 'bad input'))
    const res = await app.request('/x')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe('bad input')
  })

  it('preserves arbitrary status codes from the union', async () => {
    const app = new Hono<AppEnv>()
    app.get('/x', (c) => dashboardError(c, 412, 'PROJECT_NOT_SELECTED', 'pick a project'))
    const res = await app.request('/x')
    expect(res.status).toBe(412)
  })

  it('emits content-type application/json', async () => {
    const app = new Hono<AppEnv>()
    app.get('/x', (c) => dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'missing'))
    const res = await app.request('/x')
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})
