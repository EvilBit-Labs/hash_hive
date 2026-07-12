/**
 * Real-directory tests for the LDAP search-then-bind client
 * (`authenticateDirectory`, U2 of the AD/LDAP authentication plan,
 * docs/plans/2026-07-12-001-feat-adldap-authentication-support-plan.md).
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts), alongside the
 * Postgres-backed `tests/db` lane. Per KTD9 (no mocked `ldapts` boundary),
 * this exercises a real, throwaway OpenLDAP container booted by
 * `support/ldap-container.ts` -- see that file for the GLAuth-vs-OpenLDAP
 * container-choice rationale and the seeded fixture (an admin-group user,
 * an operator-group user, an ungrouped user, and a no-`mail` user).
 *
 * The `unavailable` scenarios (closed port, failed service bind) do not
 * need the container at all and run regardless of whether Docker/the
 * directory container is healthy.
 *
 * NOTE: this file owns and tears down its own LDAP container in its own
 * `afterAll` (unrelated to the shared Postgres pool `harness.test.ts` owns
 * and never closes -- see that file's note on `client.end()`).
 */

import { spyOn } from 'bun:test'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import net from 'node:net'

import type { LdapConfig } from '../../src/config/ldap.js'

import { logger } from '../../src/config/logger.js'
import { authenticateDirectory } from '../../src/lib/ldap/client.js'
import {
  type LdapTestDirectory,
  LDAP_TEST_ADMIN_DN,
  LDAP_TEST_ADMIN_MEMBEROF_GROUP_DN,
  LDAP_TEST_ADMIN_PASSWORD,
  LDAP_TEST_ADMIN_USER,
  LDAP_TEST_GROUP_BASE,
  LDAP_TEST_NO_MAIL_USER,
  LDAP_TEST_OPERATOR_GROUP_DN,
  LDAP_TEST_OPERATOR_MEMBEROF_GROUP_DN,
  LDAP_TEST_OPERATOR_USER,
  LDAP_TEST_PEOPLE_BASE,
  LDAP_TEST_UNGROUPED_USER,
  LDAP_TEST_UNKNOWN_USERNAME,
  startLdapTestDirectory,
} from './support/ldap-container.js'

// ─── Setup ──────────────────────────────────────────────────────────────────

let directory: LdapTestDirectory | undefined

beforeAll(async () => {
  directory = await startLdapTestDirectory()
}, 120_000)

afterAll(async () => {
  // Guarded: if beforeAll threw before assigning `directory` (a seed
  // failure), let that real error surface instead of masking it with a
  // "directory.stop is not a function" teardown crash.
  await directory?.stop()
})

function buildConfig(overrides: Partial<LdapConfig> = {}): LdapConfig {
  return {
    url: directory.url,
    tls: 'none',
    tlsCaCert: undefined,
    allowInsecureTransport: true,
    bindDn: LDAP_TEST_ADMIN_DN,
    bindPassword: LDAP_TEST_ADMIN_PASSWORD,
    searchBase: LDAP_TEST_PEOPLE_BASE,
    userFilter: '(uid=%s)',
    groupStrategy: 'memberOf',
    groupBase: undefined,
    groupRoleMap: { admin: [], operator: [], analyst: [] },
    emailAttribute: 'mail',
    realm: 'hashhive.test',
    ...overrides,
  }
}

/** Allocates then immediately frees a local TCP port, guaranteeing nothing is listening on it. */
async function getClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : undefined
      server.close(() => {
        if (port === undefined) {
          reject(new Error('failed to allocate an ephemeral port'))
          return
        }
        resolve(port)
      })
    })
  })
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('authenticateDirectory', () => {
  it('returns ok with attributes and groups for a valid service bind + user search + user re-bind', async () => {
    const result = await authenticateDirectory(
      LDAP_TEST_ADMIN_USER.username,
      LDAP_TEST_ADMIN_USER.password,
      buildConfig()
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected ok result')
    }
    expect(result.dn.toLowerCase()).toBe(LDAP_TEST_ADMIN_USER.dn.toLowerCase())
    expect(result.attributes['mail']).toBe(`${LDAP_TEST_ADMIN_USER.username}@hashhive.test`)
    expect(result.attributes['uid']).toBe(LDAP_TEST_ADMIN_USER.username)
    expect(result.groups).toContain(LDAP_TEST_ADMIN_MEMBEROF_GROUP_DN)
  })

  it('returns invalid_credentials for a wrong password against a real user', async () => {
    const result = await authenticateDirectory(
      LDAP_TEST_ADMIN_USER.username,
      'definitely-the-wrong-password',
      buildConfig()
    )

    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' })
  })

  it('returns invalid_credentials for an unknown username, with the same shape and comparable timing to a wrong password (no user-enumeration side channel)', async () => {
    const config = buildConfig()

    const wrongPasswordStart = performance.now()
    const wrongPasswordResult = await authenticateDirectory(
      LDAP_TEST_ADMIN_USER.username,
      'definitely-the-wrong-password',
      config
    )
    const wrongPasswordElapsed = performance.now() - wrongPasswordStart

    const unknownUserStart = performance.now()
    const unknownUserResult = await authenticateDirectory(
      LDAP_TEST_UNKNOWN_USERNAME,
      'definitely-the-wrong-password',
      config
    )
    const unknownUserElapsed = performance.now() - unknownUserStart

    expect(wrongPasswordResult).toEqual({ ok: false, reason: 'invalid_credentials' })
    expect(unknownUserResult).toEqual({ ok: false, reason: 'invalid_credentials' })

    // Soft timing check (generous tolerance to avoid CI flakiness): the
    // unknown-username path must not resolve as a suspiciously cheap no-op
    // relative to the wrong-password path -- that shape (near-instant
    // "no such user" vs a measurable real bind attempt) is exactly what a
    // timing side channel looks like. `authenticateDirectory` always runs a
    // second-connection bind for both cases (against a placeholder DN when
    // no entry was found), which keeps the two paths comparable.
    const slower = Math.max(wrongPasswordElapsed, unknownUserElapsed)
    const faster = Math.max(Math.min(wrongPasswordElapsed, unknownUserElapsed), 1)
    expect(slower / faster).toBeLessThan(8)
  })

  it('rejects an empty/whitespace password before any LDAP call (P0 -- RFC 4513 unauthenticated bind)', async () => {
    // Points at a closed port: if this path made any LDAP call at all, it
    // would fail to connect and surface as 'unavailable', not
    // 'invalid_credentials' -- so an 'invalid_credentials' result here
    // proves the empty-password check short-circuited before any network call.
    const closedPort = await getClosedPort()
    const config = buildConfig({ url: `ldap://127.0.0.1:${closedPort}` })

    const emptyResult = await authenticateDirectory(LDAP_TEST_ADMIN_USER.username, '', config)
    const whitespaceResult = await authenticateDirectory(
      LDAP_TEST_ADMIN_USER.username,
      '   ',
      config
    )

    expect(emptyResult).toEqual({ ok: false, reason: 'invalid_credentials' })
    expect(whitespaceResult).toEqual({ ok: false, reason: 'invalid_credentials' })
  })

  it('returns unavailable when the directory is unreachable (closed port)', async () => {
    const closedPort = await getClosedPort()
    const config = buildConfig({ url: `ldap://127.0.0.1:${closedPort}` })

    const result = await authenticateDirectory(
      LDAP_TEST_ADMIN_USER.username,
      LDAP_TEST_ADMIN_USER.password,
      config
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })

  it("returns unavailable when the service-account bind itself fails (deployment misconfiguration, not the end user's fault)", async () => {
    const config = buildConfig({ bindPassword: 'wrong-service-account-password' })

    const result = await authenticateDirectory(
      LDAP_TEST_ADMIN_USER.username,
      LDAP_TEST_ADMIN_USER.password,
      config
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('memberOf strategy reads groups off the user entry', async () => {
    const result = await authenticateDirectory(
      LDAP_TEST_OPERATOR_USER.username,
      LDAP_TEST_OPERATOR_USER.password,
      buildConfig({ groupStrategy: 'memberOf' })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected ok result')
    }
    expect(result.groups).toEqual([LDAP_TEST_OPERATOR_MEMBEROF_GROUP_DN])
  })

  it('search strategy queries the group base for entries whose member lists the user DN', async () => {
    const result = await authenticateDirectory(
      LDAP_TEST_OPERATOR_USER.username,
      LDAP_TEST_OPERATOR_USER.password,
      buildConfig({ groupStrategy: 'search', groupBase: LDAP_TEST_GROUP_BASE })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected ok result')
    }
    expect(result.groups.map((g) => g.toLowerCase())).toContain(
      LDAP_TEST_OPERATOR_GROUP_DN.toLowerCase()
    )
  })

  it('returns an empty group list for a user in no group', async () => {
    const result = await authenticateDirectory(
      LDAP_TEST_UNGROUPED_USER.username,
      LDAP_TEST_UNGROUPED_USER.password,
      buildConfig()
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected ok result')
    }
    expect(result.groups).toEqual([])
  })

  it('surfaces an absent mail attribute as undefined (U3 derives a synthesized email downstream)', async () => {
    const result = await authenticateDirectory(
      LDAP_TEST_NO_MAIL_USER.username,
      LDAP_TEST_NO_MAIL_USER.password,
      buildConfig()
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected ok result')
    }
    expect(result.attributes['mail']).toBeUndefined()
  })

  it('safely escapes a username containing LDAP filter metacharacters (no injection)', async () => {
    // If the username were substituted into the filter unescaped, this
    // would attempt to break out of the intended `(uid=%s)` expression and
    // additionally match the real admin user -- combined with the admin
    // user's REAL password, an unescaped implementation could authenticate
    // as the admin despite "nobody-such-user)(uid=admin-user" not being a
    // real username. A correctly escaped implementation treats the whole
    // string as a literal (non-matching) uid value, so this must never
    // return `ok`.
    const maliciousUsername = `${LDAP_TEST_UNKNOWN_USERNAME})(uid=${LDAP_TEST_ADMIN_USER.username}`

    const result = await authenticateDirectory(
      maliciousUsername,
      LDAP_TEST_ADMIN_USER.password,
      buildConfig()
    )

    expect(result.ok).toBe(false)
  })

  it('safely escapes a username containing a wildcard (no injection)', async () => {
    const result = await authenticateDirectory('*', 'irrelevant-password', buildConfig())

    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' })
  })

  it('never logs the submitted password or the bind secret', async () => {
    const errorSpy = spyOn(logger, 'error')
    errorSpy.mockClear()

    const config = buildConfig({ bindPassword: 'wrong-service-account-password' })
    const result = await authenticateDirectory(
      LDAP_TEST_ADMIN_USER.username,
      LDAP_TEST_ADMIN_USER.password,
      config
    )

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(errorSpy).toHaveBeenCalled()

    const serializedCalls = JSON.stringify(errorSpy.mock.calls)
    expect(serializedCalls).not.toContain(LDAP_TEST_ADMIN_USER.password)
    expect(serializedCalls).not.toContain(LDAP_TEST_ADMIN_PASSWORD)
    expect(serializedCalls).not.toContain('wrong-service-account-password')

    errorSpy.mockRestore()
  })
})
