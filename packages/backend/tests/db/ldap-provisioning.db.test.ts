/**
 * Real-DB tests for AD/LDAP JIT provisioning, account linking, and role
 * re-sync (`resolveDirectoryUser`, U4).
 *
 * Proves SQL-level behavior the mocked default lane cannot: the
 * `ba_accounts (provider_id, account_id)` unique index actually enforcing
 * R9 identity stability under real concurrency, the `ldap_link_requests`
 * CHECK constraints, and the transactional interplay between
 * `resolveDirectoryUser` and `assertLocalAdminRemains` (U6a).
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts) against the
 * isolated `hashhive_test` database, which starts with zero local admins
 * unless a test seeds one -- see setup-test-db.ts. Every describe block
 * seeds its own rows; `cleanupSeed` removes them by email domain so runs
 * are idempotent and order-independent.
 *
 * NOTE: do NOT call `client.end()` here -- `harness.test.ts` owns the
 * shared drizzle client lifecycle. NOTE: do NOT self-skip -- the test-db
 * lane always has Postgres available.
 */

import { auditLogs, baAccounts, ldapLinkRequests, users } from '@hashhive/shared'
import { afterAll, describe, expect, it } from 'bun:test'
import { and, eq, inArray, like } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { resolveDirectoryUser } from '../../src/services/ldap-provisioning.js'
import { LocalAdminFloorError } from '../../src/services/local-admin-guard.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const EMAIL_DOMAIN = 'ldap-provisioning-db-test.hashhive.local'

// ─── Seed helpers ───────────────────────────────────────────────────────────

/** Insert a local (non-directory) user row. Returns the new user's id. */
async function seedLocalUser(label: string, roles: string[] = ['analyst']): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}@${EMAIL_DOMAIN}`,
      passwordHash: null,
      name: `LDAP Provisioning Test - ${label}`,
      roles,
    })
    .returning({ id: users.id })
  return user!.id
}

/** Insert a `ba_accounts` credential row (local password) for `userId`. */
async function seedCredentialAccount(userId: number, email: string): Promise<void> {
  await db.insert(baAccounts).values({
    id: crypto.randomUUID(),
    userId,
    accountId: email,
    providerId: 'credential',
    password: 'hashed-password-placeholder',
  })
}

/** Insert a `ba_accounts` LDAP-linked row (no local password) for `userId`. */
async function seedLdapAccount(userId: number, accountId: string): Promise<void> {
  await db.insert(baAccounts).values({
    id: crypto.randomUUID(),
    userId,
    accountId,
    providerId: 'ldap',
    password: null,
  })
}

/** Remove all seed rows for this test run. Cascades handle ba_accounts / ldap_link_requests. */
async function cleanupSeed(): Promise<void> {
  const seededUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${EMAIL_DOMAIN}`))
  const ids = seededUsers.map((u) => u.id)

  // audit_logs.entity_id has no FK (polymorphic) so it does not cascade
  // when the user row is deleted -- clean it up explicitly.
  if (ids.length > 0) {
    await db
      .delete(auditLogs)
      .where(and(eq(auditLogs.entityType, 'user'), inArray(auditLogs.entityId, ids)))
  }
  await db.delete(users).where(like(users.email, `%@${EMAIL_DOMAIN}`))
}

// ─── Suite ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  await cleanupSeed()
})

describe('resolveDirectoryUser — JIT provisioning (R8)', () => {
  it('creates a new user (passwordHash null) and an ldap account with the resolved role', async () => {
    await cleanupSeed()
    const username = 'jit-new-user'
    const email = `${username}@${EMAIL_DOMAIN}`

    const result = await resolveDirectoryUser({ username, email, role: 'operator' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.user.email).toBe(email)
    expect(result.user.roles).toEqual(['operator'])

    const [row] = await db.select().from(users).where(eq(users.id, result.user.id))
    expect(row).toBeDefined()
    expect(row!.passwordHash).toBeNull()
    expect(row!.emailVerified).toBe(true)

    const [account] = await db
      .select()
      .from(baAccounts)
      .where(and(eq(baAccounts.providerId, 'ldap'), eq(baAccounts.accountId, username)))
    expect(account).toBeDefined()
    expect(account!.userId).toBe(result.user.id)
    expect(account!.password).toBeNull()

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'user'), eq(auditLogs.entityId, result.user.id)))
    expect(audit).toBeDefined()
    expect(audit!.action).toBe('ldap.provisioned')
    expect(audit!.actorType).toBe('system')
    expect(JSON.stringify(audit!.changes)).not.toContain('passwordHash')

    await cleanupSeed()
  })
})

describe('resolveDirectoryUser — repeat login stability (R9)', () => {
  it('resolves the same username to the same user id on every login', async () => {
    await cleanupSeed()
    const username = 'r9-stable-user'
    const email = `${username}@${EMAIL_DOMAIN}`

    const first = await resolveDirectoryUser({ username, email, role: 'analyst' })
    const second = await resolveDirectoryUser({ username, email, role: 'analyst' })
    const third = await resolveDirectoryUser({ username, email, role: 'analyst' })

    expect(first.ok && second.ok && third.ok).toBe(true)
    if (!first.ok || !second.ok || !third.ok) throw new Error('expected ok results')
    expect(second.user.id).toBe(first.user.id)
    expect(third.user.id).toBe(first.user.id)

    const accounts = await db
      .select()
      .from(baAccounts)
      .where(and(eq(baAccounts.providerId, 'ldap'), eq(baAccounts.accountId, username)))
    expect(accounts).toHaveLength(1)

    await cleanupSeed()
  })

  it('Covers AE4. recomputes roles on the next login after a directory promotion/demotion', async () => {
    await cleanupSeed()
    const username = 'ae4-resync-user'
    const email = `${username}@${EMAIL_DOMAIN}`

    const provisioned = await resolveDirectoryUser({ username, email, role: 'admin' })
    expect(provisioned.ok).toBe(true)
    if (!provisioned.ok) throw new Error('expected ok result')
    expect(provisioned.user.roles).toEqual(['admin'])

    const demoted = await resolveDirectoryUser({ username, email, role: 'operator' })
    expect(demoted.ok).toBe(true)
    if (!demoted.ok) throw new Error('expected ok result')
    expect(demoted.user.id).toBe(provisioned.user.id)
    expect(demoted.user.roles).toEqual(['operator'])

    const [row] = await db.select().from(users).where(eq(users.id, provisioned.user.id))
    expect(row!.roles).toEqual(['operator'])

    const syncAudits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, 'user'),
          eq(auditLogs.entityId, provisioned.user.id),
          eq(auditLogs.action, 'ldap.role_synced')
        )
      )
    expect(syncAudits).toHaveLength(1)
    expect(syncAudits[0]!.changes).toEqual({
      roles: { old: ['admin'], new: ['operator'] },
    })

    await cleanupSeed()
  })

  it('does not emit a role_synced audit row when the resolved role is unchanged', async () => {
    await cleanupSeed()
    const username = 'no-op-resync-user'
    const email = `${username}@${EMAIL_DOMAIN}`

    const first = await resolveDirectoryUser({ username, email, role: 'analyst' })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected ok result')

    await resolveDirectoryUser({ username, email, role: 'analyst' })

    const syncAudits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, 'user'),
          eq(auditLogs.entityId, first.user.id),
          eq(auditLogs.action, 'ldap.role_synced')
        )
      )
    expect(syncAudits).toHaveLength(0)

    await cleanupSeed()
  })
})

describe('resolveDirectoryUser — concurrent first login (R9)', () => {
  it('resolves a race between two simultaneous first logins to a single user', async () => {
    await cleanupSeed()
    const username = 'race-user'
    const email = `${username}@${EMAIL_DOMAIN}`
    const input = { username, email, role: 'operator' as const }

    const [resultA, resultB] = await Promise.all([
      resolveDirectoryUser(input),
      resolveDirectoryUser(input),
    ])

    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)
    if (!resultA.ok || !resultB.ok) throw new Error('expected both to resolve ok')
    expect(resultA.user.id).toBe(resultB.user.id)

    const userRows = await db.select().from(users).where(eq(users.email, email))
    expect(userRows).toHaveLength(1)

    const accountRows = await db
      .select()
      .from(baAccounts)
      .where(and(eq(baAccounts.providerId, 'ldap'), eq(baAccounts.accountId, username)))
    expect(accountRows).toHaveLength(1)

    await cleanupSeed()
  })
})

describe('resolveDirectoryUser — linking an existing passwordless account', () => {
  it('links a new ldap account and syncs roles when the matched account has no credential row', async () => {
    await cleanupSeed()
    const existingUserId = await seedLocalUser('link-target', ['analyst'])
    const email = `link-target@${EMAIL_DOMAIN}`
    const username = 'link-target-directory-username'

    const result = await resolveDirectoryUser({ username, email, role: 'operator' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.user.id).toBe(existingUserId)
    expect(result.user.roles).toEqual(['operator'])

    const [account] = await db
      .select()
      .from(baAccounts)
      .where(and(eq(baAccounts.providerId, 'ldap'), eq(baAccounts.accountId, username)))
    expect(account).toBeDefined()
    expect(account!.userId).toBe(existingUserId)

    await cleanupSeed()
  })
})

describe('resolveDirectoryUser — email collision fail-closed (R11)', () => {
  it('Covers AE6. denies and writes exactly one pending link request without mutating the existing user', async () => {
    await cleanupSeed()
    const existingUserId = await seedLocalUser('collision-target', ['analyst'])
    const email = `collision-target@${EMAIL_DOMAIN}`
    await seedCredentialAccount(existingUserId, email)
    const username = 'collision-directory-username'

    const result = await resolveDirectoryUser({ username, email, role: 'admin' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a collision denial')
    expect(result.reason).toBe('collision')
    expect(typeof result.linkRequestId).toBe('number')

    const pending = await db
      .select()
      .from(ldapLinkRequests)
      .where(eq(ldapLinkRequests.username, username))
    expect(pending).toHaveLength(1)
    expect(pending[0]!.derivedEmail).toBe(email)
    expect(pending[0]!.resolvedRole).toBe('admin')
    expect(pending[0]!.matchedUserId).toBe(existingUserId)
    expect(pending[0]!.status).toBe('pending')

    // The existing user is never mutated: roles unchanged, no ldap account linked.
    const [row] = await db.select().from(users).where(eq(users.id, existingUserId))
    expect(row!.roles).toEqual(['analyst'])
    const ldapAccounts = await db
      .select()
      .from(baAccounts)
      .where(and(eq(baAccounts.userId, existingUserId), eq(baAccounts.providerId, 'ldap')))
    expect(ldapAccounts).toHaveLength(0)

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, 'user'),
          eq(auditLogs.entityId, existingUserId),
          eq(auditLogs.action, 'ldap.collision')
        )
      )
    expect(audit).toBeDefined()
    expect(audit!.changes).toBeNull()
    expect(JSON.stringify(audit)).not.toContain('hashed-password-placeholder')

    await cleanupSeed()
  })
})

describe('resolveDirectoryUser — break-glass floor guard (U6a integration)', () => {
  it('rejects a re-sync that would demote the sole local admin', async () => {
    await cleanupSeed()
    const email = `sole-admin@${EMAIL_DOMAIN}`
    const userId = await seedLocalUser('sole-admin', ['admin'])
    await seedCredentialAccount(userId, email)
    // Simulate a U7 reconciliation link: this local admin also has a
    // directory identity linked to their account.
    const username = 'sole-admin-directory-username'
    await seedLdapAccount(userId, username)

    await expect(resolveDirectoryUser({ username, email, role: 'operator' })).rejects.toThrow(
      LocalAdminFloorError
    )

    // Rejected, not silently applied: roles are unchanged.
    const [row] = await db.select().from(users).where(eq(users.id, userId))
    expect(row!.roles).toEqual(['admin'])

    await cleanupSeed()
  })

  it('allows the re-sync when another local admin exists', async () => {
    await cleanupSeed()
    const otherEmail = `other-admin@${EMAIL_DOMAIN}`
    const otherAdminId = await seedLocalUser('other-admin', ['admin'])
    await seedCredentialAccount(otherAdminId, otherEmail)

    const email = `linked-admin@${EMAIL_DOMAIN}`
    const userId = await seedLocalUser('linked-admin', ['admin'])
    await seedCredentialAccount(userId, email)
    const username = 'linked-admin-directory-username'
    await seedLdapAccount(userId, username)

    const result = await resolveDirectoryUser({ username, email, role: 'operator' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.user.roles).toEqual(['operator'])

    await cleanupSeed()
  })
})
