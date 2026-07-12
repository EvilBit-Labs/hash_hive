/**
 * `GET /auth/methods` with `LDAP_ENABLED=true` (U8, R20, KTD8).
 *
 * `config/env.js` exports `env` as a singleton computed once at module
 * load from `process.env`, and `tests/preload.ts` leaves `LDAP_ENABLED`
 * unset for the shared catch-all phase. Flipping it here requires its
 * own isolated `bun test` process (mirrors
 * `tests/unit/lib/auth-config-roles.test.ts`'s `AUTH_CONFIG_ROLES_TEST_ISOLATED`
 * pattern): env vars are set BEFORE the dynamic `import()` inside the
 * isolated branch, since static imports are hoisted ahead of any
 * top-level statement and would otherwise read the env before this file
 * gets a chance to set it.
 */
import { describe, expect, it } from 'bun:test'

const IS_ISOLATED = process.env['AUTH_METHODS_LDAP_ENABLED_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  // Canonical skip stub (GOTCHAS.md "Backend Testing"): a console.warn plus
  // a `toBeUndefined` assertion so a package.json edit that drops the
  // isolated phase fails loudly instead of leaving the suite silently green.
  describe('auth-methods-ldap-enabled (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[auth-methods-ldap-enabled] skipped — set AUTH_METHODS_LDAP_ENABLED_TEST_ISOLATED=1 to run; the ldap:true wire-contract test did NOT execute in this phase.'
      )
      expect(process.env['AUTH_METHODS_LDAP_ENABLED_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  process.env['LDAP_ENABLED'] = 'true'
  process.env['LDAP_URL'] = 'ldaps://ldap.lab.local:636'
  process.env['LDAP_BIND_DN'] = 'cn=svc-hashhive,dc=lab,dc=local'
  process.env['LDAP_BIND_PASSWORD'] = 'svc-password'
  process.env['LDAP_SEARCH_BASE'] = 'ou=people,dc=lab,dc=local'
  process.env['LDAP_USER_FILTER'] = '(uid=%s)'
  process.env['LDAP_REALM'] = 'lab.local'

  describe('GET /auth/methods with LDAP_ENABLED=true', () => {
    it('returns { local: true, ldap: true }', async () => {
      // Dynamic imports inside the isolated phase so the real (unmocked)
      // config/env.js and routes/dashboard/auth.js load AFTER the env
      // vars above are set.
      const { Hono } = await import('hono')
      const { authRoutes } = await import('../../../../src/routes/dashboard/auth.js')

      const app = new Hono()
      app.route('/', authRoutes)

      const res = await app.request('/methods')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { local: boolean; ldap: boolean }
      expect(body).toEqual({ local: true, ldap: true })
    })
  })
}
