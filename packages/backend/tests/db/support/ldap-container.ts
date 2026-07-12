/**
 * Boots a real, throwaway LDAP directory via testcontainers and seeds it
 * with the fixture users/groups the U2 client tests (`ldap-client.db.test.ts`)
 * exercise (KTD9: real-directory tests, no mocked `ldapts` boundary).
 * Torn down in the test file's own `afterAll` -- this container is
 * unrelated to the shared Postgres pool `tests/db/harness.test.ts` owns and
 * follows its own lifecycle.
 *
 * Container choice: GLAuth vs OpenLDAP (KTD9's documented open question).
 * The plan defaults to GLAuth, but GLAuth's "full compatibility mode"
 * (https://glauth.github.io/docs/compatibility.html) exposes group
 * membership as `groupOfUniqueNames`/`uniqueMember`, not the `member`
 * attribute U2's `search` group strategy queries for -- and GLAuth's
 * `memberOf` is computed only from its own hardcoded group model, with no
 * way to independently seed edge cases this fixture needs (a user in no
 * group at all, a user with no `mail` attribute). A real OpenLDAP container
 * (`osixia/openldap`) gives exact control over both group strategies from
 * one seed with no extra glue, so this helper uses that instead, per
 * KTD9's documented escape hatch ("switch to OpenLDAP only if
 * memberOf/schema fidelity requires it").
 *
 * `osixia/openldap` bootstraps with the real `memberof` overlay already
 * wired up (its default (non-custom) bootstrap ldifs load the `memberof`
 * and `refint` modules on the main database unconditionally) -- so this
 * fixture does NOT need a custom schema hack to fake the attribute. The
 * overlay's own default config (`olcMemberOfGroupOC: groupOfUniqueNames`,
 * `olcMemberOfMemberAD: uniqueMember`) triggers on `groupOfUniqueNames`
 * entries' `uniqueMember` attribute, not `groupOfNames`/`member` -- so this
 * fixture seeds TWO parallel group entries per membership: a
 * `groupOfUniqueNames` entry (suffixed `-memberof`) that the overlay
 * back-patches onto each member's real `memberOf` attribute, and a
 * `groupOfNames` entry (the plain `cn=hh-admins`/`cn=hh-operators` DN
 * exported below) that U2's `search` strategy queries via its hardcoded
 * `(member=...)` filter. Reconfiguring the overlay's `cn=config` entry
 * in-place to accept `groupOfNames`/`member` directly was tried first and
 * works, but raced unreliably against the overlay's own schema
 * registration immediately after container start in this environment;
 * seeding both group shapes from their respective out-of-the-box defaults
 * is simpler and deterministic.
 *
 * Seeding strategy: rather than injecting custom bootstrap LDIF files for
 * osixia's own entrypoint to load at first-start (that path raced against
 * this image's "copy /container/service into /container/run/service, then
 * read bootstrap ldifs from there" startup sequence unreliably in this
 * environment -- the custom directory was sometimes still empty when the
 * entrypoint read it, silently seeding nothing), this helper waits for the
 * container to accept a real LDAP connection and then seeds every fixture
 * entry itself over the wire via `ldapts`. That is deterministic: it only
 * proceeds once the server has actually proven it can bind and add
 * entries, with no dependency on container-internal file-copy timing.
 * Group entries are added after the users they reference (users are
 * created before groups below), since the overlay only back-patches
 * `memberOf` for members that already exist at the time a group naming
 * them is added.
 *
 * Only plain LDAP (port 389, `LDAP_TLS=false`) is exercised here. U2's
 * `client.ts` TLS code paths (`ldaps`, `starttls`, custom CA) are exercised
 * by construction/unit-level review, not by a live TLS handshake against
 * this container -- wiring a self-signed cert into the seeding flow is
 * extra container-infra complexity the U2 test scenarios in the
 * implementation plan do not call for (they cover search-then-bind
 * behavior, group strategies, injection escaping, and no-enumeration
 * timing, not transport security).
 */

import { Client } from 'ldapts'
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers'

// ─── Fixture identifiers ────────────────────────────────────────────────────

export const LDAP_TEST_BASE_DN = 'dc=hashhive,dc=test'
export const LDAP_TEST_PEOPLE_BASE = `ou=people,${LDAP_TEST_BASE_DN}`
export const LDAP_TEST_GROUP_BASE = `ou=groups,${LDAP_TEST_BASE_DN}`
export const LDAP_TEST_ADMIN_DN = `cn=admin,${LDAP_TEST_BASE_DN}`
export const LDAP_TEST_ADMIN_PASSWORD = 'hh-test-admin-password'

/** `groupOfNames`/`member` -- what U2's `search` group strategy queries for. */
export const LDAP_TEST_ADMIN_GROUP_DN = `cn=hh-admins,${LDAP_TEST_GROUP_BASE}`
export const LDAP_TEST_OPERATOR_GROUP_DN = `cn=hh-operators,${LDAP_TEST_GROUP_BASE}`
/**
 * `groupOfUniqueNames`/`uniqueMember` counterparts that the `memberof`
 * overlay's out-of-the-box default config actually watches (see module
 * doc) -- these are what shows up in a seeded user's real `memberOf`
 * attribute, not the `groupOfNames` DNs above.
 */
export const LDAP_TEST_ADMIN_MEMBEROF_GROUP_DN = `cn=hh-admins-memberof,${LDAP_TEST_GROUP_BASE}`
export const LDAP_TEST_OPERATOR_MEMBEROF_GROUP_DN = `cn=hh-operators-memberof,${LDAP_TEST_GROUP_BASE}`

export interface LdapTestUser {
  username: string
  password: string
  dn: string
  mail?: string
}

/** In `hh-admins` only. */
export const LDAP_TEST_ADMIN_USER: LdapTestUser = {
  username: 'admin-user',
  password: 'admin-user-password',
  dn: `uid=admin-user,${LDAP_TEST_PEOPLE_BASE}`,
  mail: 'admin-user@hashhive.test',
}
/** In `hh-operators` only. */
export const LDAP_TEST_OPERATOR_USER: LdapTestUser = {
  username: 'operator-user',
  password: 'operator-user-password',
  dn: `uid=operator-user,${LDAP_TEST_PEOPLE_BASE}`,
  mail: 'operator-user@hashhive.test',
}
/** In no group -- exercises the fail-closed "no mapped group" path upstream in U3. */
export const LDAP_TEST_UNGROUPED_USER: LdapTestUser = {
  username: 'ungrouped-user',
  password: 'ungrouped-user-password',
  dn: `uid=ungrouped-user,${LDAP_TEST_PEOPLE_BASE}`,
  mail: 'ungrouped-user@hashhive.test',
}
/** In `hh-operators`, but has no `mail` attribute -- exercises U3's deriveEmail fallback (AE5). */
export const LDAP_TEST_NO_MAIL_USER: LdapTestUser = {
  username: 'no-mail-user',
  password: 'no-mail-user-password',
  dn: `uid=no-mail-user,${LDAP_TEST_PEOPLE_BASE}`,
}

const FIXTURE_USERS: readonly LdapTestUser[] = [
  LDAP_TEST_ADMIN_USER,
  LDAP_TEST_OPERATOR_USER,
  LDAP_TEST_UNGROUPED_USER,
  LDAP_TEST_NO_MAIL_USER,
]

/** A username that is never seeded -- used for the unknown-username / no-enumeration test. */
export const LDAP_TEST_UNKNOWN_USERNAME = 'nobody-such-user'

// ─── Container lifecycle ────────────────────────────────────────────────────

export interface LdapTestDirectory {
  url: string
  container: StartedTestContainer
  stop(): Promise<void>
}

/**
 * This dev machine's Docker daemon typically has several unrelated
 * containers and even a local k8s cluster competing for the same VM's CPU
 * and memory, which has been observed to make the LDAP container's
 * internal startup sequence and even individual LDAP operations
 * transiently slow or drop a connection mid-operation. Every operation in
 * this file therefore runs through a short-lived connection with a
 * generous retry budget rather than a single long-lived connection, so a
 * transient hiccup under host contention doesn't fail the whole seed.
 */
const RETRY_ATTEMPTS = 15
const RETRY_DELAY_MS = 500
const OPERATION_TIMEOUT_MS = 15_000
/**
 * Budget for the memberof-overlay settle poll (see `waitForMemberOf`).
 * Deliberately bounded rather than very large: `startLdapTestDirectory`
 * retries the whole container boot+seed on failure, and a fresh container
 * converges far more reliably than waiting longer on one that has not
 * fired at all -- see that function's doc.
 */
const MEMBEROF_SETTLE_ATTEMPTS = 15

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Runs `operation` against a fresh admin-bound connection, retrying the
 * whole bind+operation+unbind sequence on any failure (connection refused,
 * a mid-operation drop, or a bind that races the server's own startup).
 */
async function withAdminClient<T>(
  url: string,
  operation: (client: Client) => Promise<T>
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    const client = new Client({
      url,
      connectTimeout: 5_000,
      timeout: OPERATION_TIMEOUT_MS,
    })
    try {
      await client.bind(LDAP_TEST_ADMIN_DN, LDAP_TEST_ADMIN_PASSWORD)
      return await operation(client)
    } catch (err) {
      lastError = err
      await sleep(RETRY_DELAY_MS)
    } finally {
      await client.unbind().catch(() => {})
    }
  }
  throw new Error(
    `ldap-container: operation failed after ${RETRY_ATTEMPTS} attempts: ${String(lastError)}`
  )
}

/** True for an LDAP "entry already exists" response -- safe to treat a retried add as already-succeeded. */
function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error && err.name === 'AlreadyExistsError'
}

/** Adds `dn`, retrying the whole connection on failure; a retry that lands on an already-created entry (from a prior attempt whose response was lost) counts as success. */
async function addIdempotent(
  url: string,
  dn: string,
  attributes: Record<string, string[]>
): Promise<void> {
  await withAdminClient(url, async (client) => {
    try {
      await client.add(dn, attributes)
    } catch (err) {
      if (!isAlreadyExists(err)) {
        throw err
      }
    }
  })
}

async function seedFixtures(url: string): Promise<void> {
  await addIdempotent(url, LDAP_TEST_PEOPLE_BASE, {
    objectClass: ['organizationalUnit'],
    ou: ['people'],
  })
  await addIdempotent(url, LDAP_TEST_GROUP_BASE, {
    objectClass: ['organizationalUnit'],
    ou: ['groups'],
  })

  for (const user of FIXTURE_USERS) {
    const attributes: Record<string, string[]> = {
      objectClass: ['inetOrgPerson'],
      uid: [user.username],
      cn: [user.username],
      sn: [user.username],
      userPassword: [user.password],
    }
    if (user.mail) {
      attributes['mail'] = [user.mail]
    }
    await addIdempotent(url, user.dn, attributes)
  }

  // groupOfNames/member -- queried by U2's `search` group strategy.
  await addIdempotent(url, LDAP_TEST_ADMIN_GROUP_DN, {
    objectClass: ['groupOfNames'],
    cn: ['hh-admins'],
    member: [LDAP_TEST_ADMIN_USER.dn],
  })
  await addIdempotent(url, LDAP_TEST_OPERATOR_GROUP_DN, {
    objectClass: ['groupOfNames'],
    cn: ['hh-operators'],
    member: [LDAP_TEST_OPERATOR_USER.dn, LDAP_TEST_NO_MAIL_USER.dn],
  })

  // groupOfUniqueNames/uniqueMember -- what the memberof overlay's default
  // config actually watches, so adding these is what makes the overlay
  // back-patch each referenced member's real `memberOf` attribute.
  await addIdempotent(url, LDAP_TEST_ADMIN_MEMBEROF_GROUP_DN, {
    objectClass: ['groupOfUniqueNames'],
    cn: ['hh-admins-memberof'],
    uniqueMember: [LDAP_TEST_ADMIN_USER.dn],
  })
  await addIdempotent(url, LDAP_TEST_OPERATOR_MEMBEROF_GROUP_DN, {
    objectClass: ['groupOfUniqueNames'],
    cn: ['hh-operators-memberof'],
    uniqueMember: [LDAP_TEST_OPERATOR_USER.dn, LDAP_TEST_NO_MAIL_USER.dn],
  })

  // The memberof overlay's back-patch of a member's `memberOf` attribute
  // has been observed to lag slightly behind the group ADD response under
  // host contention (see the retry-budget comment above). Poll until it
  // settles so callers never observe a half-seeded fixture -- a real
  // seeding failure still throws, after exhausting retries, instead of
  // hanging.
  await waitForMemberOf(url, LDAP_TEST_ADMIN_USER.dn, LDAP_TEST_ADMIN_MEMBEROF_GROUP_DN)
  await waitForMemberOf(url, LDAP_TEST_OPERATOR_USER.dn, LDAP_TEST_OPERATOR_MEMBEROF_GROUP_DN)
}

/** Polls a user entry until the memberof overlay has back-patched the expected `memberOf` value onto it. */
async function waitForMemberOf(
  url: string,
  userDn: string,
  expectedGroupDn: string
): Promise<void> {
  // A generous budget of its own: this has been observed to occasionally
  // take several seconds (not just the usual sub-second) under the host
  // contention described above, well past a typical `RETRY_ATTEMPTS` budget.
  for (let attempt = 0; attempt < MEMBEROF_SETTLE_ATTEMPTS; attempt++) {
    const found = await withAdminClient(url, async (client) => {
      const { searchEntries } = await client.search(userDn, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['memberOf'],
      })
      const raw = searchEntries[0]?.['memberOf']
      const values = Array.isArray(raw) ? raw : raw ? [raw] : []
      return values.includes(expectedGroupDn)
    }).catch(() => false)

    if (found) {
      return
    }
    await sleep(RETRY_DELAY_MS)
  }
  throw new Error(
    `ldap-container: memberOf on ${userDn} never settled to include ${expectedGroupDn} after ${MEMBEROF_SETTLE_ATTEMPTS} attempts`
  )
}

async function bootAndSeed(): Promise<LdapTestDirectory> {
  const container = await new GenericContainer('osixia/openldap:1.5.0')
    .withExposedPorts(389)
    .withEnvironment({
      LDAP_ORGANISATION: 'HashHive Test',
      LDAP_DOMAIN: 'hashhive.test',
      LDAP_BASE_DN: LDAP_TEST_BASE_DN,
      LDAP_ADMIN_PASSWORD: LDAP_TEST_ADMIN_PASSWORD,
      LDAP_CONFIG_PASSWORD: LDAP_TEST_ADMIN_PASSWORD,
      LDAP_TLS: 'false',
    })
    .withWaitStrategy(Wait.forListeningPorts().withStartupTimeout(120_000))
    .start()

  const url = `ldap://${container.getHost()}:${container.getMappedPort(389)}`

  try {
    await seedFixtures(url)
  } catch (err) {
    await container.stop().catch(() => {})
    throw err
  }

  return {
    url,
    container,
    stop: async () => {
      await container.stop()
    },
  }
}

const BOOT_ATTEMPTS = 6

/**
 * Starts a plain OpenLDAP container, waits for it to accept connections,
 * and seeds the fixture users/groups over the wire (see module doc for
 * why seeding happens this way instead of via bootstrap LDIF files).
 * Callers are responsible for calling `stop()` in their own `afterAll`.
 *
 * The `memberof` overlay's backpatch of a member's `memberOf` attribute
 * (see `waitForMemberOf`) has been observed to occasionally never fire for
 * an entire container's lifetime -- not merely lag -- on an otherwise
 * correctly-configured container in this environment; more patience
 * within a single container does not help (see the plan's U2 evidence
 * notes for the investigation). Retrying with an entirely fresh container
 * converges reliably in practice, so a seeding failure here retries the
 * whole boot+seed up to `BOOT_ATTEMPTS` times before giving up for real.
 */
export async function startLdapTestDirectory(): Promise<LdapTestDirectory> {
  let lastError: unknown
  for (let attempt = 0; attempt < BOOT_ATTEMPTS; attempt++) {
    try {
      return await bootAndSeed()
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(
    `ldap-container: failed to boot and seed a working directory after ${BOOT_ATTEMPTS} attempts: ${String(lastError)}`
  )
}
