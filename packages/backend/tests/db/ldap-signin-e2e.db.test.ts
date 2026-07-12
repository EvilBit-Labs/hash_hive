/**
 * End-to-end tests for `POST /api/auth/sign-in/ldap` (U5 of the AD/LDAP
 * authentication plan,
 * docs/plans/2026-07-12-001-feat-adldap-authentication-support-plan.md).
 *
 * Exercises the FULL plugin flow -- client (U2, real OpenLDAP testcontainer)
 * -> mapping (U3) -> provisioning (U4, real Postgres) -> BetterAuth session
 * issuance (U5) -- over real HTTP request/response objects via
 * `auth.handler(...)`, per KTD9 (no mocked `ldapts` boundary, no DB mocking).
 *
 * Deliberately does NOT import the real `../../src/lib/auth.js` singleton
 * for the sign-in flow itself. That singleton reads its LDAP configuration
 * from the process-wide `env` object (`config/env.ts`), which is parsed
 * once at first import and frozen; `tests/db` runs every file in this
 * directory in a single `bun test` invocation (`just test-db`), and other
 * files in this directory (e.g. `harness.test.ts`) import modules that
 * transitively load `config/env.js` before this file's `beforeAll` can set
 * `LDAP_*` env vars to the testcontainer's dynamic port -- so mutating
 * `process.env` here would either be a no-op (frozen singleton) or, worse,
 * silently test a differently-configured instance. `ldapPlugin(config)`
 * takes its `LdapConfig` as a plain argument specifically so it doesn't
 * need `env` at all (same reason U2's `authenticateDirectory` and U4's
 * `resolveDirectoryUser` tests never touch `config/env.ts` either) --  this
 * file builds a small standalone `betterAuth()` instance, mirroring
 * `lib/auth.ts`'s session/user/account/hooks shape closely enough to prove
 * the real session-issuance contract, and reuses the REAL
 * `computeInitialSessionProjectId` hook function from `lib/auth.ts` (safe
 * to import -- it has no LDAP dependency) so the `projectId` auto-select
 * assertion below exercises the actual production hook, not a re-implementation.
 *
 * The `LDAP_ENABLED=false` -> "plugin absent" regression is covered
 * separately in the isolated unit-test phase
 * (`tests/unit/lib/ldap/plugin.test.ts`), which reads the real env-driven
 * singleton -- this file only needs a plugin instance to test against.
 *
 * NOTE: this file owns and tears down its own LDAP container in its own
 * `afterAll`, mirroring `ldap-client.db.test.ts`. NOTE: do NOT call
 * `client.end()` on `db` -- `harness.test.ts` owns that lifecycle.
 */

import { auditLogs, baAccounts, baSessions, projects, projectUsers, users } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, inArray, like } from 'drizzle-orm'
import net from 'node:net'

import type { LdapConfig } from '../../src/config/ldap.js'

import { db } from '../../src/db/index.js'
import { computeInitialSessionProjectId } from '../../src/lib/auth.js'
import { ldapPlugin } from '../../src/lib/ldap/plugin.js'
import {
  type LdapTestDirectory,
  LDAP_TEST_ADMIN_MEMBEROF_GROUP_DN,
  LDAP_TEST_ADMIN_PASSWORD,
  LDAP_TEST_ADMIN_USER,
  LDAP_TEST_OPERATOR_MEMBEROF_GROUP_DN,
  LDAP_TEST_OPERATOR_USER,
  LDAP_TEST_PEOPLE_BASE,
  LDAP_TEST_UNGROUPED_USER,
  startLdapTestDirectory,
} from './support/ldap-container.js'

// ─── Test-only betterAuth instance (see module doc) ────────────────────────

const TEST_SECRET = 'ldap-signin-e2e-test-secret-must-be-at-least-32-characters'
const EMAIL_DOMAIN = 'hashhive.test'
const PROJECT_SLUG = 'ldap-signin-e2e-project'

function buildLdapConfig(overrides: Partial<LdapConfig> = {}): LdapConfig {
  return {
    url: directory.url,
    tls: 'none',
    tlsCaCert: undefined,
    allowInsecureTransport: true,
    bindDn: `cn=admin,dc=hashhive,dc=test`,
    bindPassword: LDAP_TEST_ADMIN_PASSWORD,
    searchBase: LDAP_TEST_PEOPLE_BASE,
    userFilter: '(uid=%s)',
    groupStrategy: 'memberOf',
    groupBase: undefined,
    groupRoleMap: {
      admin: [LDAP_TEST_ADMIN_MEMBEROF_GROUP_DN],
      operator: [LDAP_TEST_OPERATOR_MEMBEROF_GROUP_DN],
      analyst: [],
    },
    emailAttribute: 'mail',
    realm: EMAIL_DOMAIN,
    ...overrides,
  }
}

async function buildTestAuth(config: LdapConfig) {
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
    session: {
      expiresIn: 28800,
      updateAge: 3600,
      additionalFields: {
        projectId: { type: 'number', required: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session: Record<string, unknown>) => {
            const projectId = await computeInitialSessionProjectId(Number(session['userId']))
            if (projectId === null) {
              return { data: session }
            }
            return { data: { ...session, projectId } }
          },
        },
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
    plugins: [ldapPlugin(config)],
  })
}

type TestAuth = Awaited<ReturnType<typeof buildTestAuth>>

async function postSignIn(auth: TestAuth, body: unknown): Promise<Response> {
  return auth.handler(
    new Request('http://localhost/api/auth/sign-in/ldap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
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

async function cleanupSeed(): Promise<void> {
  const seededUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${EMAIL_DOMAIN}`))
  const ids = seededUsers.map((u) => u.id)

  // audit_logs.entity_id has no FK (polymorphic) so it does not cascade
  // when the user row is deleted -- delete it explicitly, by the seeded
  // user ids, BEFORE the users themselves. Must run before the `users`
  // delete below: once those rows are gone there is no way to identify
  // which audit_logs rows belonged to them.
  if (ids.length > 0) {
    await db
      .delete(auditLogs)
      .where(and(eq(auditLogs.entityType, 'user'), inArray(auditLogs.entityId, ids)))
  }
  await db.delete(users).where(like(users.email, `%@${EMAIL_DOMAIN}`))
  await db.delete(projects).where(eq(projects.slug, PROJECT_SLUG))
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let directory: LdapTestDirectory

beforeAll(async () => {
  directory = await startLdapTestDirectory()
  await cleanupSeed()
}, 120_000)

afterAll(async () => {
  await cleanupSeed()
  await directory?.stop()
})

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('POST /api/auth/sign-in/ldap (U5 end-to-end)', () => {
  it('Covers AE7. returns 503 when the directory is unreachable, with no local-password attempt made', async () => {
    const closedPort = await getClosedPort()
    const auth = await buildTestAuth(buildLdapConfig({ url: `ldap://127.0.0.1:${closedPort}` }))

    const response = await postSignIn(auth, {
      username: LDAP_TEST_OPERATOR_USER.username,
      password: LDAP_TEST_OPERATOR_USER.password,
    })

    expect(response.status).toBe(503)
    const body = (await response.json()) as { code?: string }
    expect(body.code).toBe('LDAP_DIRECTORY_UNAVAILABLE')
  })

  it('returns 400 for a malformed body (missing password)', async () => {
    const auth = await buildTestAuth(buildLdapConfig())

    const response = await postSignIn(auth, { username: 'jdoe' })

    expect(response.status).toBe(400)
  })

  it('returns 401 for a wrong password, without creating a HashHive account', async () => {
    const auth = await buildTestAuth(buildLdapConfig())

    const response = await postSignIn(auth, {
      username: LDAP_TEST_OPERATOR_USER.username,
      password: 'definitely-the-wrong-password',
    })

    expect(response.status).toBe(401)

    const rows = await db
      .select()
      .from(baAccounts)
      .where(
        and(
          eq(baAccounts.providerId, 'ldap'),
          eq(baAccounts.accountId, LDAP_TEST_OPERATOR_USER.username)
        )
      )
    expect(rows).toHaveLength(0)
  })

  it('Covers AE2. returns 403 for a user in no mapped group, and creates no HashHive account', async () => {
    const auth = await buildTestAuth(buildLdapConfig())

    const response = await postSignIn(auth, {
      username: LDAP_TEST_UNGROUPED_USER.username,
      password: LDAP_TEST_UNGROUPED_USER.password,
    })

    expect(response.status).toBe(403)

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.email, LDAP_TEST_UNGROUPED_USER.mail ?? ''))
    expect(rows).toHaveLength(0)
  })

  it('Covers AE6. returns 409 with a reconciliation reason when the derived email collides with a local-password account', async () => {
    await cleanupSeed()
    const collisionEmail = LDAP_TEST_ADMIN_USER.mail as string

    const [existing] = await db
      .insert(users)
      .values({ email: collisionEmail, name: 'Pre-existing local admin', roles: ['analyst'] })
      .returning()
    await db.insert(baAccounts).values({
      id: crypto.randomUUID(),
      userId: existing!.id,
      accountId: collisionEmail,
      providerId: 'credential',
      password: 'hashed-password-placeholder',
    })

    const auth = await buildTestAuth(buildLdapConfig())
    const response = await postSignIn(auth, {
      username: LDAP_TEST_ADMIN_USER.username,
      password: LDAP_TEST_ADMIN_USER.password,
    })

    expect(response.status).toBe(409)
    const body = (await response.json()) as { linkRequestId?: number }
    expect(typeof body.linkRequestId).toBe('number')

    const [row] = await db.select().from(users).where(eq(users.id, existing!.id))
    expect(row!.roles).toEqual(['analyst']) // existing user never mutated

    await cleanupSeed()
  })

  it('Covers AE1, R1, R8. valid creds + mapped group -> 200, issues a session cookie, and provisions real users/ba_accounts rows', async () => {
    await cleanupSeed()
    const auth = await buildTestAuth(buildLdapConfig())

    const response = await postSignIn(auth, {
      username: LDAP_TEST_OPERATOR_USER.username,
      password: LDAP_TEST_OPERATOR_USER.password,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeTruthy()

    const body = (await response.json()) as {
      token: string
      user: { id: number; email: string; roles: string[] }
    }
    expect(body.user.roles).toEqual(['operator'])
    expect(body.user.email).toBe(LDAP_TEST_OPERATOR_USER.mail)

    const [account] = await db
      .select()
      .from(baAccounts)
      .where(
        and(
          eq(baAccounts.providerId, 'ldap'),
          eq(baAccounts.accountId, LDAP_TEST_OPERATOR_USER.username)
        )
      )
    expect(account).toBeDefined()
    expect(account!.userId).toBe(body.user.id)

    const [row] = await db.select().from(users).where(eq(users.id, body.user.id))
    expect(row!.passwordHash).toBeNull()

    const [sessionRow] = await db.select().from(baSessions).where(eq(baSessions.token, body.token))
    expect(sessionRow).toBeDefined()
    // No project membership yet -- computeInitialSessionProjectId's
    // "single project" branch cannot fire, so projectId stays null. The
    // next test proves the branch DOES fire once a membership exists.
    expect(sessionRow!.projectId).toBeNull()

    await cleanupSeed()
  })

  it('Covers R1 session issuance through core. the databaseHooks.session.create.before projectId hook auto-selects a single project membership', async () => {
    await cleanupSeed()
    const auth = await buildTestAuth(buildLdapConfig())

    const first = await postSignIn(auth, {
      username: LDAP_TEST_OPERATOR_USER.username,
      password: LDAP_TEST_OPERATOR_USER.password,
    })
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { user: { id: number } }

    const [project] = await db
      .insert(projects)
      .values({ name: 'LDAP sign-in e2e project', slug: PROJECT_SLUG })
      .returning()
    await db.insert(projectUsers).values({
      userId: firstBody.user.id,
      projectId: project!.id,
      roles: ['contributor'],
    })

    const second = await postSignIn(auth, {
      username: LDAP_TEST_OPERATOR_USER.username,
      password: LDAP_TEST_OPERATOR_USER.password,
    })
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { token: string }

    const [sessionRow] = await db
      .select()
      .from(baSessions)
      .where(eq(baSessions.token, secondBody.token))
    expect(sessionRow).toBeDefined()
    expect(sessionRow!.projectId).toBe(project!.id)

    await cleanupSeed()
  })
})
