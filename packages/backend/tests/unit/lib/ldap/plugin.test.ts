import { ldapSignInBodySchema } from '@hashhive/shared'
import { describe, expect, it } from 'bun:test'

/**
 * Unit tests for the BetterAuth LDAP plugin (U5 of the AD/LDAP
 * authentication plan,
 * docs/plans/2026-07-12-001-feat-adldap-authentication-support-plan.md).
 *
 * Two things under test:
 *
 *  - `resolveLdapSignIn`'s branching (R22 typed outcomes, never a raw
 *    500) via plain dependency injection -- no `mock.module` needed, since
 *    the function takes its collaborators (`authenticateDirectory`,
 *    `resolveRole`, `deriveEmail`, `resolveDirectoryUser`) as an explicit
 *    `deps` argument. Mirrors `computeInitialSessionProjectId` in
 *    `lib/auth.ts`, which was extracted from a BetterAuth hook for exactly
 *    this reason.
 *  - `outcomeToApiError`'s outcome -> HTTP status mapping (401/403/409/503).
 *  - `ldapPlugin`'s structural shape: the plugin id, the endpoint it
 *    registers, and the rate-limit rule mirroring BetterAuth's own
 *    `/sign-in/*` default (10s window, 3 attempts) -- per the plan's
 *    required correction, verified structurally here since BetterAuth's
 *    rate limiting is disabled outside production by default
 *    (`options.rateLimit?.enabled ?? isProduction`), so a live 429 in this
 *    test env would prove nothing.
 *
 * The "plugin absent from the auth instance when LDAP_ENABLED=false" case
 * (R17 regression) imports the REAL, unmocked `../../../../src/lib/auth.js`
 * singleton -- mirroring `tests/unit/lib/auth-config-roles.test.ts`, this
 * file is a *victim* of module mocking (non-isolated dashboard route tests
 * call `mock.module('.../lib/auth.js', ...)`, stripping `.options`
 * process-wide), so it runs in its own isolated `bun:test` invocation via
 * the `LDAP_PLUGIN_TEST_ISOLATED` env gate.
 *
 * The full HTTP-level flow (200 with a session cookie + the `projectId`
 * hook, and the framework-level 400 for a malformed body) is exercised
 * end-to-end against a real directory + real DB in
 * `tests/db/ldap-signin-e2e.db.test.ts` -- that is the only place a real
 * BetterAuth endpoint context (cookies, `internalAdapter`, hooks) exists.
 */
import type { LdapConfig } from '../../../../src/config/ldap.js'

import {
  outcomeToApiError,
  ldapPlugin,
  resolveLdapSignIn,
} from '../../../../src/lib/ldap/plugin.js'
import { LocalAdminFloorError } from '../../../../src/services/local-admin-guard.js'

const IS_ISOLATED = process.env['LDAP_PLUGIN_TEST_ISOLATED'] === '1'

function fakeConfig(overrides: Partial<LdapConfig> = {}): LdapConfig {
  return {
    url: 'ldaps://ldap.lab.local:636',
    tls: 'ldaps',
    tlsCaCert: undefined,
    allowInsecureTransport: false,
    bindDn: 'cn=svc,dc=lab,dc=local',
    bindPassword: 'svc-password',
    searchBase: 'ou=people,dc=lab,dc=local',
    userFilter: '(uid=%s)',
    groupStrategy: 'memberOf',
    groupBase: undefined,
    groupRoleMap: { admin: ['cn=hh-admins'], operator: ['cn=hh-operators'], analyst: [] },
    emailAttribute: 'mail',
    realm: 'lab.local',
    ...overrides,
  }
}

if (!IS_ISOLATED) {
  // Canonical skip stub (GOTCHAS.md "Backend Testing"): a console.warn plus
  // a `toBeUndefined` assertion so a package.json edit that drops the
  // isolated phase fails loudly instead of leaving the suite silently green.
  describe('ldap plugin (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[ldap plugin] skipped — set LDAP_PLUGIN_TEST_ISOLATED=1 to run; the plugin suite did NOT execute in this phase.'
      )
      expect(process.env['LDAP_PLUGIN_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  const RESOLVED_USER = {
    id: 42,
    email: 'jdoe@lab.local',
    name: 'jdoe',
    roles: ['operator'] as const,
  }

  describe('resolveLdapSignIn', () => {
    it('returns unavailable when the directory client reports unavailable', async () => {
      const outcome = await resolveLdapSignIn(
        { username: 'jdoe', password: 'secret' },
        fakeConfig(),
        {
          authenticateDirectory: async () => ({ ok: false, reason: 'unavailable' }),
          resolveRole: () => {
            throw new Error('must not be called when the directory is unavailable')
          },
          deriveEmail: () => {
            throw new Error('must not be called when the directory is unavailable')
          },
          resolveDirectoryUser: async () => {
            throw new Error('must not be called when the directory is unavailable')
          },
        }
      )

      expect(outcome).toEqual({ kind: 'unavailable' })
    })

    it('returns invalid_credentials for a wrong password / unknown username, and never falls through to a local check (R15)', async () => {
      const outcome = await resolveLdapSignIn(
        { username: 'jdoe', password: 'wrong' },
        fakeConfig(),
        {
          authenticateDirectory: async () => ({ ok: false, reason: 'invalid_credentials' }),
          resolveRole: () => {
            throw new Error('must not be called for invalid credentials')
          },
          deriveEmail: () => {
            throw new Error('must not be called for invalid credentials')
          },
          resolveDirectoryUser: async () => {
            throw new Error('must not be called for invalid credentials')
          },
        }
      )

      expect(outcome).toEqual({ kind: 'invalid_credentials' })
    })

    it('Covers AE2. returns no_mapped_group when the authenticated user matches no mapped group', async () => {
      const outcome = await resolveLdapSignIn(
        { username: 'jdoe', password: 'secret' },
        fakeConfig(),
        {
          authenticateDirectory: async () => ({
            ok: true,
            dn: 'uid=jdoe,ou=people,dc=lab,dc=local',
            attributes: {},
            groups: ['cn=some-other-group'],
          }),
          resolveRole: () => null,
          deriveEmail: () => {
            throw new Error('must not derive an email when no role is mapped')
          },
          resolveDirectoryUser: async () => {
            throw new Error('must not provision when no role is mapped')
          },
        }
      )

      expect(outcome).toEqual({ kind: 'no_mapped_group' })
    })

    it('Covers AE6. returns collision with the pending link-request id when resolveDirectoryUser denies', async () => {
      const outcome = await resolveLdapSignIn(
        { username: 'jdoe', password: 'secret' },
        fakeConfig(),
        {
          authenticateDirectory: async () => ({
            ok: true,
            dn: 'uid=jdoe,ou=people,dc=lab,dc=local',
            attributes: { mail: 'jdoe@lab.local' },
            groups: ['cn=hh-operators'],
          }),
          resolveRole: () => 'operator',
          deriveEmail: () => 'jdoe@lab.local',
          resolveDirectoryUser: async () => ({ ok: false, reason: 'collision', linkRequestId: 7 }),
        }
      )

      expect(outcome).toEqual({ kind: 'collision', linkRequestId: 7 })
    })

    it('returns role_sync_blocked (not a raw throw) when resolveDirectoryUser rejects with LocalAdminFloorError', async () => {
      const outcome = await resolveLdapSignIn(
        { username: 'jdoe', password: 'secret' },
        fakeConfig(),
        {
          authenticateDirectory: async () => ({
            ok: true,
            dn: 'uid=jdoe,ou=people,dc=lab,dc=local',
            attributes: {},
            groups: ['cn=hh-operators'],
          }),
          resolveRole: () => 'operator',
          deriveEmail: () => 'jdoe@lab.local',
          resolveDirectoryUser: async () => {
            throw new LocalAdminFloorError({ kind: 'demote', userId: 42 })
          },
        }
      )

      expect(outcome.kind).toBe('role_sync_blocked')
    })

    it('re-throws an unexpected (non-LocalAdminFloorError) error from resolveDirectoryUser instead of swallowing it', async () => {
      await expect(
        resolveLdapSignIn({ username: 'jdoe', password: 'secret' }, fakeConfig(), {
          authenticateDirectory: async () => ({
            ok: true,
            dn: 'uid=jdoe,ou=people,dc=lab,dc=local',
            attributes: {},
            groups: ['cn=hh-operators'],
          }),
          resolveRole: () => 'operator',
          deriveEmail: () => 'jdoe@lab.local',
          resolveDirectoryUser: async () => {
            throw new Error('unexpected db failure')
          },
        })
      ).rejects.toThrow('unexpected db failure')
    })

    it('Covers AE1. returns success with the resolved user on a valid credential + mapped group', async () => {
      const outcome = await resolveLdapSignIn(
        { username: 'jdoe', password: 'secret' },
        fakeConfig(),
        {
          authenticateDirectory: async () => ({
            ok: true,
            dn: 'uid=jdoe,ou=people,dc=lab,dc=local',
            attributes: { mail: 'jdoe@lab.local' },
            groups: ['cn=hh-operators'],
          }),
          resolveRole: () => 'operator',
          deriveEmail: () => 'jdoe@lab.local',
          resolveDirectoryUser: async () => ({ ok: true, user: RESOLVED_USER }),
        }
      )

      expect(outcome).toEqual({ kind: 'success', user: RESOLVED_USER })
    })
  })

  describe('outcomeToApiError', () => {
    it('maps unavailable to 503 (Covers AE7)', () => {
      const err = outcomeToApiError({ kind: 'unavailable' })
      expect(err.statusCode).toBe(503)
    })

    it('maps invalid_credentials to 401', () => {
      const err = outcomeToApiError({ kind: 'invalid_credentials' })
      expect(err.statusCode).toBe(401)
    })

    it('maps no_mapped_group to 403 (Covers AE2)', () => {
      const err = outcomeToApiError({ kind: 'no_mapped_group' })
      expect(err.statusCode).toBe(403)
    })

    it('maps role_sync_blocked to 403', () => {
      const err = outcomeToApiError({ kind: 'role_sync_blocked', reason: 'floor guard' })
      expect(err.statusCode).toBe(403)
    })

    it('maps collision to 409 and carries the link-request id as a reconciliation reason', () => {
      const err = outcomeToApiError({ kind: 'collision', linkRequestId: 7 })
      expect(err.statusCode).toBe(409)
      expect((err.body as { linkRequestId?: number } | undefined)?.linkRequestId).toBe(7)
    })
  })

  describe('ldapPlugin', () => {
    it('registers the ldap plugin id and the /sign-in/ldap endpoint', () => {
      const plugin = ldapPlugin(fakeConfig())

      expect(plugin.id).toBe('ldap')
      expect(plugin.endpoints?.['signInLdap']).toBeDefined()
    })

    it('mirrors BetterAuth default /sign-in/* rate limiting (10s window, 3 attempts) for /sign-in/ldap only', () => {
      const plugin = ldapPlugin(fakeConfig())
      const rule = plugin.rateLimit?.[0]

      expect(plugin.rateLimit).toHaveLength(1)
      expect(rule?.window).toBe(10)
      expect(rule?.max).toBe(3)
      expect(rule?.pathMatcher('/sign-in/ldap')).toBe(true)
      expect(rule?.pathMatcher('/sign-in/email')).toBe(false)
    })
  })

  describe('ldapSignInBodySchema', () => {
    it('rejects a malformed body (missing password) -- the framework-level 400 path', () => {
      const result = ldapSignInBodySchema.safeParse({ username: 'jdoe' })
      expect(result.success).toBe(false)
    })

    it('rejects an empty username or password', () => {
      expect(ldapSignInBodySchema.safeParse({ username: '', password: 'x' }).success).toBe(false)
      expect(ldapSignInBodySchema.safeParse({ username: 'jdoe', password: '' }).success).toBe(false)
    })

    it('accepts a well-formed body', () => {
      const result = ldapSignInBodySchema.safeParse({ username: 'jdoe', password: 'secret' })
      expect(result.success).toBe(true)
    })

    // Bounds an otherwise-unbounded body on the anonymous LDAP-connecting
    // endpoint (FIX 5 / P2 code review): oversized username/password bodies
    // are rejected with a 400 rather than reaching authenticateDirectory.
    it('accepts a username/password at the max length boundary', () => {
      const result = ldapSignInBodySchema.safeParse({
        username: 'a'.repeat(256),
        password: 'b'.repeat(1024),
      })
      expect(result.success).toBe(true)
    })

    it('rejects a username over 256 characters', () => {
      const result = ldapSignInBodySchema.safeParse({
        username: 'a'.repeat(257),
        password: 'secret',
      })
      expect(result.success).toBe(false)
    })

    it('rejects a password over 1024 characters', () => {
      const result = ldapSignInBodySchema.safeParse({
        username: 'jdoe',
        password: 'b'.repeat(1025),
      })
      expect(result.success).toBe(false)
    })
  })

  describe('auth singleton: ldap plugin is absent when LDAP_ENABLED=false (R17 regression)', () => {
    it('mounts no plugin with id "ldap" under the default test env', async () => {
      // Import inside the isolated phase so the real (unmocked) module loads
      // -- mirrors auth-config-roles.test.ts. tests/preload.ts sets no
      // LDAP_* vars, so LDAP_ENABLED defaults to false here.
      const { auth } = await import('../../../../src/lib/auth.js')
      const plugins = auth.options.plugins ?? []

      expect(plugins.find((p) => p.id === 'ldap')).toBeUndefined()
    })
  })
}
