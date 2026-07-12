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
import { like } from 'drizzle-orm'

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
