/**
 * `GET /api/v1/dashboard/auth/methods` -- anonymous auth-method discovery
 * (U8 of the AD/LDAP authentication plan,
 * docs/plans/2026-07-12-001-feat-adldap-authentication-support-plan.md,
 * R20, KTD8).
 *
 * Two things under test here (the `ldap: true` branch needs its own
 * isolated phase -- see `auth-methods-ldap-enabled.test.ts` -- because
 * `config/env.js` reads `process.env.LDAP_ENABLED` once at module load,
 * and this process's `tests/preload.ts` leaves it unset):
 *  - the default (`LDAP_ENABLED` unset) response is `{ local: true,
 *    ldap: false }`, so an existing deployment's login page renders
 *    byte-for-byte unchanged (R20's "when directory auth is disabled the
 *    login page is unchanged" regression).
 *  - the route is genuinely anonymous: no session cookie is required, and
 *    the OTHER routes on this same router (`/me`, `/me/api-key`) still
 *    require one -- a regression guard for the `authRouter.use('*',
 *    requireSession)` -> per-path refactor this endpoint required.
 *
 * `db` and `lib/auth.js` are mocked (mirroring
 * `tests/unit/dashboard-api-key-routes.test.ts` and
 * `tests/unit/routes/auth-me-selected-project.test.ts`) so this suite
 * never depends on a live Postgres/session -- `getSession` always
 * resolves `null` here since every case either doesn't need a session
 * (`/methods`) or specifically asserts the 401-without-session path
 * (`/me`).
 */
import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

import type { AppEnv } from '../../../../src/types.js'

mock.module('../../../../src/db/index.js', () => ({ db: {} as never, client: {} }))

mock.module('../../../../src/lib/auth.js', () => ({
  auth: {
    api: { getSession: async () => null },
    handler: async () => new Response('ok'),
  },
}))

import { authRoutes } from '../../../../src/routes/dashboard/auth.js'

function makeApp() {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-req')
    await next()
  })
  app.route('/', authRoutes)
  return app
}

describe('GET /auth/methods', () => {
  it('returns { local: true, ldap: false } when LDAP_ENABLED is unset (default)', async () => {
    const res = await makeApp().request('/methods')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { local: boolean; ldap: boolean }
    expect(body).toEqual({ local: true, ldap: false })
  })

  it('requires no session cookie (anonymous)', async () => {
    const res = await makeApp().request('/methods')
    expect(res.status).not.toBe(401)
  })

  it('leaks no LDAP configuration beyond the boolean flag', async () => {
    const res = await makeApp().request('/methods')
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).toSorted()).toEqual(['ldap', 'local'])
  })

  it('sibling /me still requires a session (per-path requireSession regression guard)', async () => {
    const res = await makeApp().request('/me')
    expect(res.status).toBe(401)
  })
})
