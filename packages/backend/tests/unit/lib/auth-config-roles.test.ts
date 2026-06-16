/**
 * Regression guard for issue #228 -- global-admin dashboard endpoints
 * 403 because the session never hydrates `currentUser.roles`.
 *
 * BetterAuth only surfaces user columns it has been told about. Without
 * the `user.additionalFields.roles` declaration in `lib/auth.ts`,
 * `session.user.roles` comes back undefined, `coerceRoles` yields [],
 * and every global-tier `requireRole(...)` check 403s for a legitimate
 * admin. The dashboard route unit tests inject `roles` onto the *mocked*
 * `getSession` payload, so they keep passing even with the field
 * removed -- they cannot catch this regression. This assertion can: it
 * reads the real `auth` config object and fails the moment the field is
 * dropped.
 *
 * `input: false` is load-bearing: it blocks any client-facing write path
 * (e.g. a future `updateUser`) from setting roles, closing a
 * privilege-escalation vector. Roles stay admin/seed-managed only.
 *
 * Runs in an isolated test phase via the `AUTH_CONFIG_ROLES_TEST_ISOLATED`
 * env gate. This file is a *victim* of module mocking, not a source:
 * the non-isolated dashboard route tests call
 * `mock.module('.../lib/auth.js', ...)`, which replaces the `auth`
 * singleton's live binding process-wide and strips `.options`. Running
 * in its own bun:test invocation guarantees the real, unmocked config.
 */
import { describe, expect, it } from 'bun:test'

const IS_ISOLATED = process.env['AUTH_CONFIG_ROLES_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  // Canonical skip stub (GOTCHAS.md "Backend Testing"): a console.warn plus
  // a `toBeUndefined` assertion so a package.json edit that drops the
  // isolated phase fails loudly instead of leaving the suite silently green.
  describe('auth-config-roles (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[auth-config-roles] skipped — set AUTH_CONFIG_ROLES_TEST_ISOLATED=1 to run; the config-contract suite did NOT execute in this phase.'
      )
      expect(process.env['AUTH_CONFIG_ROLES_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  describe('auth config: users.roles is surfaced on the session (issue #228)', () => {
    it('declares roles as a non-input user additional field', async () => {
      // Import inside the isolated phase so the real (unmocked) module loads.
      const { auth } = await import('../../../src/lib/auth.js')
      const additionalFields = auth.options.user?.additionalFields as
        | Record<string, { type?: unknown; input?: boolean }>
        | undefined
      const roles = additionalFields?.['roles']

      expect(roles).toBeDefined()
      // text[] column must surface as a JS string[] on session.user.
      expect(roles?.type).toBe('string[]')
      // Must NOT be client-settable -- roles are admin/seed-managed only.
      expect(roles?.input).toBe(false)
    })
  })
}
