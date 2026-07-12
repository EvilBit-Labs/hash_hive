/**
 * Break-glass regression tests (U6b of the AD/LDAP authentication plan,
 * docs/plans/2026-07-12-001-feat-adldap-authentication-support-plan.md).
 * Requirements: R13, R14, R15.
 *
 * U6a's `assertLocalAdminRemains` guard-unit scenarios (demote/delete/clear
 * of the last local admin, the another-admin-exists success paths, and the
 * directory-provisioned-admin exclusion) are already covered by
 * `tests/db/local-admin-guard.db.test.ts` -- this file does NOT duplicate
 * them.
 *
 * This file adds the one thing the guard-unit tests cannot exercise on
 * their own: proving R14 ("a directory outage never blocks local login")
 * and R15 ("directory auth never falls through to a local-password check")
 * together, end to end, against a SINGLE BetterAuth instance that wires up
 * BOTH `emailAndPassword` AND the `ldap` plugin -- mirroring the shape of
 * the real `lib/auth.ts` singleton when `LDAP_ENABLED=true` -- with the
 * ldap plugin pointed at an unreachable directory (a closed TCP port, the
 * same technique `ldap-signin-e2e.db.test.ts` uses for its own 503 case;
 * no container is needed for this scenario per the plan).
 *
 * Deliberately does NOT import the real `../../src/lib/auth.js` singleton,
 * for the same reason `ldap-signin-e2e.db.test.ts` does not: that
 * singleton's LDAP config is read from the process-wide, frozen `env`
 * object at first import, and `tests/db` runs every file in this directory
 * in one `bun test` invocation -- see that file's module doc for the full
 * rationale. This file builds its own small standalone `betterAuth()`
 * instance instead, mirroring `lib/auth.ts`'s `emailAndPassword` config
 * (including the bcrypt `password.hash`/`password.verify` override) and
 * passing a hand-built `LdapConfig` straight to `ldapPlugin(...)`.
 *
 * NOTE: do NOT call `client.end()` on `db` here -- `harness.test.ts` owns
 * that lifecycle for every file in the `tests/db` lane.
 */

import { baAccounts, baSessions, users } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, like } from 'drizzle-orm'
import net from 'node:net'

import type { LdapConfig } from '../../src/config/ldap.js'

import { db } from '../../src/db/index.js'
import { ldapPlugin } from '../../src/lib/ldap/plugin.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const TEST_SECRET = 'break-glass-invariant-test-secret-must-be-at-least-32-characters'
const EMAIL_DOMAIN = 'break-glass-invariant-db-test.hashhive.local'
const LOCAL_ADMIN_EMAIL = `seeded-local-admin@${EMAIL_DOMAIN}`
const LOCAL_ADMIN_PASSWORD = 'correct-horse-battery-staple-9000'
const BCRYPT_COST = 12

// ─── LDAP config pointed at an unreachable directory ───────────────────────

/**
 * A syntactically valid `LdapConfig` whose `url` points at a closed local
 * TCP port, so every `authenticateDirectory` call fails with `unavailable`
 * (connection refused) -- no directory container needed for this scenario.
 */
function buildUnavailableLdapConfig(closedPortUrl: string): LdapConfig {
  return {
    url: closedPortUrl,
    tls: 'none',
    tlsCaCert: undefined,
    allowInsecureTransport: true,
    bindDn: 'cn=admin,dc=hashhive,dc=test',
    bindPassword: 'irrelevant-directory-is-unreachable',
    searchBase: 'ou=people,dc=hashhive,dc=test',
    userFilter: '(uid=%s)',
    groupStrategy: 'memberOf',
    groupBase: undefined,
    groupRoleMap: { admin: [], operator: [], analyst: [] },
    emailAttribute: 'mail',
    realm: 'hashhive.test',
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

// ─── Test-only betterAuth instance ─────────────────────────────────────────

/**
 * A standalone betterAuth instance mirroring `lib/auth.ts`'s
 * `emailAndPassword` + `ldap` plugin shape (see module doc for why this
 * file does not import the real singleton). Both sign-in paths are wired
 * onto the SAME instance so this test proves they genuinely coexist -- an
 * unreachable directory must not block the local path (R14), and the
 * local path must never be consulted as a fallback for a failed directory
 * attempt (R15).
 */
async function buildTestAuth(ldapConfig: LdapConfig) {
  const { betterAuth } = await import('better-auth')
  const { drizzleAdapter } = await import('better-auth/adapters/drizzle')
  const schema = await import('@hashhive/shared')

  return betterAuth({
    basePath: '/api/auth',
    secret: TEST_SECRET,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        users: schema.users,
        session: schema.baSessions,
        ba_accounts: schema.baAccounts,
        verification: schema.baVerifications,
      },
    }),
    // Mirrors lib/auth.ts's emailAndPassword block, including the bcrypt
    // hash/verify override, so a raw-seeded ba_accounts credential row
    // (hashed the same way below) verifies exactly like production.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      autoSignIn: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      password: {
        hash: async (password: string) =>
          Bun.password.hash(password, { algorithm: 'bcrypt', cost: BCRYPT_COST }),
        verify: async ({ hash, password }: { hash: string; password: string }) =>
          Bun.password.verify(password, hash),
      },
    },
    user: {
      modelName: 'users',
      additionalFields: {
        roles: { type: 'string[]', required: false, input: false },
      },
    },
    account: { modelName: 'ba_accounts' },
    advanced: {
      database: {
        generateId: ({ model }: { model: string }) =>
          model === 'user' ? false : crypto.randomUUID(),
      },
    },
    // The plugin under test always exists here (LDAP_ENABLED=true shape) --
    // only its target directory is unreachable. This is the case R14/R15
    // guard against: a directory OUTAGE, not directory auth being disabled.
    plugins: [ldapPlugin(ldapConfig)],
  })
}

type TestAuth = Awaited<ReturnType<typeof buildTestAuth>>

async function postJson(auth: TestAuth, path: string, body: unknown): Promise<Response> {
  return auth.handler(
    new Request(`http://localhost/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
}

// ─── Seed helpers ───────────────────────────────────────────────────────────

/** Seeds a genuine local admin: a `users` row with `roles: ['admin']` plus a `ba_accounts` credential row bcrypt-hashed the same way `emailAndPassword.password.hash` above hashes it. */
async function seedLocalAdmin(): Promise<number> {
  const passwordHash = await Bun.password.hash(LOCAL_ADMIN_PASSWORD, {
    algorithm: 'bcrypt',
    cost: BCRYPT_COST,
  })
  const [user] = await db
    .insert(users)
    .values({
      email: LOCAL_ADMIN_EMAIL,
      name: 'Break-glass Invariant Test Admin',
      roles: ['admin'],
      emailVerified: true,
    })
    .returning({ id: users.id })
  if (!user) {
    throw new Error('seedLocalAdmin: insert returned no row')
  }
  await db.insert(baAccounts).values({
    id: crypto.randomUUID(),
    userId: user.id,
    accountId: LOCAL_ADMIN_EMAIL,
    providerId: 'credential',
    password: passwordHash,
  })
  return user.id
}

/** Removes all seed rows for this test run. `ba_accounts`/sessions cascade off `users`. */
async function cleanupSeed(): Promise<void> {
  await db.delete(users).where(like(users.email, `%@${EMAIL_DOMAIN}`))
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let closedPortUrl: string

beforeAll(async () => {
  const closedPort = await getClosedPort()
  closedPortUrl = `ldap://127.0.0.1:${closedPort}`
  await cleanupSeed()
})

afterAll(async () => {
  await cleanupSeed()
})

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('Break-glass invariant: directory outage never blocks local login (R13, R14, R15)', () => {
  it('Covers AE7, R13, R14. the seeded local admin still authenticates via the normal email/password path while the directory is unreachable', async () => {
    await cleanupSeed()
    const adminId = await seedLocalAdmin()
    const auth = await buildTestAuth(buildUnavailableLdapConfig(closedPortUrl))

    const response = await postJson(auth, '/sign-in/email', {
      email: LOCAL_ADMIN_EMAIL,
      password: LOCAL_ADMIN_PASSWORD,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeTruthy()

    // BetterAuth's built-in `/sign-in/email` response serializes `user.id`
    // as a string regardless of the underlying column type (unlike the
    // `ldap` plugin's own hand-written `ctx.json(...)` in plugin.ts, which
    // returns the numeric id as-is) -- coerce before comparing.
    const body = (await response.json()) as { token: string; user: { id: string; email: string } }
    expect(Number(body.user.id)).toBe(adminId)
    expect(body.user.email).toBe(LOCAL_ADMIN_EMAIL)

    const [sessionRow] = await db.select().from(baSessions).where(eq(baSessions.token, body.token))
    expect(sessionRow).toBeDefined()
    expect(sessionRow!.userId).toBe(adminId)

    await cleanupSeed()
  })

  it('a wrong local password is still rejected with 401 on the same instance, confirming local sign-in is a genuine credential check, not a directory-outage bypass', async () => {
    await cleanupSeed()
    await seedLocalAdmin()
    const auth = await buildTestAuth(buildUnavailableLdapConfig(closedPortUrl))

    const response = await postJson(auth, '/sign-in/email', {
      email: LOCAL_ADMIN_EMAIL,
      password: 'definitely-the-wrong-password',
    })

    expect(response.status).toBe(401)

    await cleanupSeed()
  })

  it("Covers AE7, R15. a directory sign-in attempt returns 503 with no local-password fallthrough, even when the submitted directory credentials exactly match the local admin's own valid email/password", async () => {
    await cleanupSeed()
    await seedLocalAdmin()
    const auth = await buildTestAuth(buildUnavailableLdapConfig(closedPortUrl))

    // The critical no-fallthrough proof: these are the LOCAL admin's real,
    // valid credentials, submitted to the DIRECTORY sign-in path. If R15
    // were violated -- if a failed directory bind ever fell back to
    // checking a local password for the same identifier -- this request
    // would return 200. It must not: the directory is unreachable, so the
    // outcome is unconditionally 503 regardless of what the submitted
    // password happens to match locally.
    const response = await postJson(auth, '/sign-in/ldap', {
      username: LOCAL_ADMIN_EMAIL,
      password: LOCAL_ADMIN_PASSWORD,
    })

    expect(response.status).toBe(503)
    const body = (await response.json()) as { code?: string }
    expect(body.code).toBe('LDAP_DIRECTORY_UNAVAILABLE')
    expect(response.headers.get('set-cookie')).toBeFalsy()

    // No side effect on the DB from the failed directory attempt: no new
    // `ldap`-provider account was created or linked for this identifier.
    const rows = await db
      .select()
      .from(baAccounts)
      .where(and(eq(baAccounts.providerId, 'ldap'), eq(baAccounts.accountId, LOCAL_ADMIN_EMAIL)))
    expect(rows).toHaveLength(0)

    await cleanupSeed()
  })
})
