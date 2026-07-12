/**
 * Real-DB tests for the break-glass local-admin floor guard
 * (`assertLocalAdminRemains`, U6a).
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts).
 * Every describe block manages its own seed rows; `cleanupSeed` removes
 * them so runs are idempotent and order-independent.
 *
 * NOTE: do NOT call `client.end()` here — `harness.test.ts` owns the shared
 * drizzle client lifecycle and closes it in its own `afterAll`. All test
 * files in the `tests/db` lane share the same module-level client.
 */

import { baAccounts, users } from '@hashhive/shared'
import { afterAll, describe, expect, it } from 'bun:test'
import { and, eq, isNotNull, like } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import {
  assertLocalAdminRemains,
  LocalAdminFloorError,
} from '../../src/services/local-admin-guard.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const EMAIL_DOMAIN = 'local-admin-guard-db-test.hashhive.local'

// ─── Seed helpers ───────────────────────────────────────────────────────────

/**
 * Insert a user row. `roles` defaults to `['admin']`. Returns the new
 * user's id.
 */
async function seedUser(label: string, roles: string[] = ['admin']): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}@${EMAIL_DOMAIN}`,
      passwordHash: 'x',
      name: `Local Admin Guard Test - ${label}`,
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

/** Remove all seed rows for this test run. Cascades handle ba_accounts. */
async function cleanupSeed(): Promise<void> {
  await db.delete(users).where(like(users.email, `%@${EMAIL_DOMAIN}`))
}

// ─── Suite ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  await cleanupSeed()
})

describe('assertLocalAdminRemains', () => {
  it('rejects demoting the last local admin', async () => {
    await cleanupSeed()
    const email = `demote-last@${EMAIL_DOMAIN}`
    const userId = await seedUser('demote-last', ['admin'])
    await seedCredentialAccount(userId, email)

    await expect(
      db.transaction(async (tx) => {
        await assertLocalAdminRemains(tx, { kind: 'demote', userId })
      })
    ).rejects.toThrow(LocalAdminFloorError)

    await cleanupSeed()
  })

  it('allows demoting an admin when another local-password admin exists', async () => {
    await cleanupSeed()
    const emailA = `demote-a@${EMAIL_DOMAIN}`
    const emailB = `demote-b@${EMAIL_DOMAIN}`
    const userIdA = await seedUser('demote-a', ['admin'])
    const userIdB = await seedUser('demote-b', ['admin'])
    await seedCredentialAccount(userIdA, emailA)
    await seedCredentialAccount(userIdB, emailB)

    await expect(
      db.transaction(async (tx) => {
        await assertLocalAdminRemains(tx, { kind: 'demote', userId: userIdA })
      })
    ).resolves.toBeUndefined()

    await cleanupSeed()
  })

  it('rejects deleting the last local admin', async () => {
    await cleanupSeed()
    const email = `delete-last@${EMAIL_DOMAIN}`
    const userId = await seedUser('delete-last', ['admin'])
    await seedCredentialAccount(userId, email)

    await expect(
      db.transaction(async (tx) => {
        await assertLocalAdminRemains(tx, { kind: 'delete', userId })
      })
    ).rejects.toThrow(LocalAdminFloorError)

    await cleanupSeed()
  })

  it('allows deleting an admin when another local-password admin exists', async () => {
    await cleanupSeed()
    const emailA = `delete-a@${EMAIL_DOMAIN}`
    const emailB = `delete-b@${EMAIL_DOMAIN}`
    const userIdA = await seedUser('delete-a', ['admin'])
    const userIdB = await seedUser('delete-b', ['admin'])
    await seedCredentialAccount(userIdA, emailA)
    await seedCredentialAccount(userIdB, emailB)

    await expect(
      db.transaction(async (tx) => {
        await assertLocalAdminRemains(tx, { kind: 'delete', userId: userIdA })
      })
    ).resolves.toBeUndefined()

    await cleanupSeed()
  })

  it('rejects clearing the local password of the last local admin', async () => {
    await cleanupSeed()
    const email = `clear-pw-last@${EMAIL_DOMAIN}`
    const userId = await seedUser('clear-pw-last', ['admin'])
    await seedCredentialAccount(userId, email)

    await expect(
      db.transaction(async (tx) => {
        await assertLocalAdminRemains(tx, { kind: 'clear_password', userId })
      })
    ).rejects.toThrow(LocalAdminFloorError)

    await cleanupSeed()
  })

  it('does not count a directory-provisioned admin toward the local-admin floor', async () => {
    await cleanupSeed()
    const realEmail = `real-admin@${EMAIL_DOMAIN}`
    const realAdminId = await seedUser('real-admin', ['admin'])
    await seedCredentialAccount(realAdminId, realEmail)

    // Directory-provisioned admin: roles include 'admin', but only an
    // `ldap` provider row exists — no `credential` row, so this user must
    // NOT count toward the floor per KTD3.
    const directoryAdminId = await seedUser('directory-admin', ['admin'])
    await seedLdapAccount(directoryAdminId, 'directory-admin')

    // With only the directory admin left after removing the real local
    // admin, the floor would drop to zero — rejected.
    await expect(
      db.transaction(async (tx) => {
        await assertLocalAdminRemains(tx, { kind: 'demote', userId: realAdminId })
      })
    ).rejects.toThrow(LocalAdminFloorError)

    await cleanupSeed()
  })

  // FIX 2 (P0/P1 code review): assertLocalAdminRemains previously read the
  // local-admin set with an unlocked SELECT under READ COMMITTED, so two
  // concurrent transactions could both observe "one other local admin
  // remains", both pass the check, and both commit their demotion --
  // leaving zero local admins despite the guard. A transaction-scoped
  // `pg_advisory_xact_lock` on a single fixed key now serializes every
  // call to `assertLocalAdminRemains`, so this must be impossible: with
  // exactly two local-password admins, two REAL concurrent transactions
  // that each demote a different one must resolve to exactly one success
  // and one LocalAdminFloorError, and exactly one local admin must remain
  // in the database afterward.
  it('serializes concurrent assertLocalAdminRemains calls so exactly one local admin always remains (advisory lock)', async () => {
    await cleanupSeed()
    const emailA = `concurrent-a@${EMAIL_DOMAIN}`
    const emailB = `concurrent-b@${EMAIL_DOMAIN}`
    const userIdA = await seedUser('concurrent-a', ['admin'])
    const userIdB = await seedUser('concurrent-b', ['admin'])
    await seedCredentialAccount(userIdA, emailA)
    await seedCredentialAccount(userIdB, emailB)

    // Models the real caller shape (U4/U7): assert-then-mutate inside one
    // transaction. Clearing the credential password is the guard's
    // `clear_password` mutation kind, applied for real so the DB state
    // after both transactions reflects what actually happened, not just
    // what the guard predicted.
    async function demoteByClearingPassword(userId: number): Promise<void> {
      await db.transaction(async (tx) => {
        await assertLocalAdminRemains(tx, { kind: 'clear_password', userId })
        await tx
          .update(baAccounts)
          .set({ password: null })
          .where(and(eq(baAccounts.userId, userId), eq(baAccounts.providerId, 'credential')))
      })
    }

    const results = await Promise.allSettled([
      demoteByClearingPassword(userIdA),
      demoteByClearingPassword(userIdB),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    // Exactly one of the two concurrent demotions succeeds -- the lock
    // serializes them, so whichever transaction's advisory lock acquires
    // first sees "2 local admins, demoting 1 leaves 1" and commits; the
    // second re-reads AFTER the first commits, sees "1 local admin left,
    // demoting it leaves 0", and is rejected.
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(rejected[0]?.reason).toBeInstanceOf(LocalAdminFloorError)

    // The invariant itself, not just the thrown error: exactly one local
    // admin from this seed remains with a non-null credential password.
    const remaining = await db
      .select({ userId: baAccounts.userId })
      .from(baAccounts)
      .where(and(eq(baAccounts.providerId, 'credential'), isNotNull(baAccounts.password)))
    const remainingInSeed = remaining.filter(
      (row) => row.userId === userIdA || row.userId === userIdB
    )
    expect(remainingInSeed.length).toBe(1)

    await cleanupSeed()
  })

  it('rejects any mutation kind on a user who is not currently a local admin without throwing spuriously when another admin exists', async () => {
    await cleanupSeed()
    const emailA = `other-a@${EMAIL_DOMAIN}`
    const userIdA = await seedUser('other-a', ['admin'])
    await seedCredentialAccount(userIdA, emailA)

    // A non-admin analyst user: mutating them never affects the local-admin
    // floor, so the guard must resolve normally regardless of mutation kind.
    const analystId = await seedUser('analyst', ['analyst'])

    await expect(
      db.transaction(async (tx) => {
        await assertLocalAdminRemains(tx, { kind: 'delete', userId: analystId })
      })
    ).resolves.toBeUndefined()

    await cleanupSeed()
  })
})
