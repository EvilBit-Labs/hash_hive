/**
 * Real-DB tests for the break-glass admin seed script (`seed-admin.ts`).
 *
 * Proves the P0 guarantee the script's module doc describes: seeding the
 * admin writes not just a `users` row with `roles: ['admin']`, but also a
 * `ba_accounts` credential row (`providerId: 'credential'`, a non-null
 * password) -- the row `assertLocalAdminRemains` (U6a,
 * `services/local-admin-guard.ts`) actually reads to count a user toward
 * the break-glass local-admin floor. Before this test existed, the script
 * was never exercised by any test, so a regression here (e.g. dropping the
 * `ba_accounts` upsert) could ship an admin that cannot sign in and does
 * not protect the floor, undetected.
 *
 * Uses `seedAdmin({ email, password })` with a scoped test identity rather
 * than the real `SEED_ADMIN_EMAIL` default, so this test never mutates the
 * actual break-glass admin account.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts) against the
 * isolated `hashhive_test` database.
 *
 * NOTE: do NOT call `client.end()` here -- `harness.test.ts` owns the
 * shared drizzle client lifecycle. NOTE: do NOT self-skip -- the test-db
 * lane always has Postgres available.
 */

import { baAccounts, projectUsers, users } from '@hashhive/shared'
import { afterAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { seedAdmin } from '../../src/scripts/seed-admin.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const TEST_EMAIL = 'seed-admin-db-test@hashhive.local'
const TEST_PASSWORD = 'seed-admin-db-test-password-123'

// ─── Seed helpers ───────────────────────────────────────────────────────────

/**
 * Remove the seeded test admin row (and its ba_accounts / project_users
 * rows via FK cascade -- see the schema's onDelete: 'cascade'). Does NOT
 * touch the shared 'Default Project' row seedAdmin also upserts -- that
 * row is a harmless, idempotent fixture shared with the real `db:seed`
 * flow and other tests never depend on its absence.
 */
async function cleanupSeed(): Promise<void> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, TEST_EMAIL))
  if (!row) return
  await db.delete(projectUsers).where(eq(projectUsers.userId, row.id))
  await db.delete(baAccounts).where(eq(baAccounts.userId, row.id))
  await db.delete(users).where(eq(users.id, row.id))
}

// ─── Suite ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  await cleanupSeed()
})

describe('seedAdmin — break-glass floor guarantee (U6b)', () => {
  it('creates the admin user AND a ba_accounts credential row with a non-null password', async () => {
    await cleanupSeed()

    await seedAdmin({ email: TEST_EMAIL, password: TEST_PASSWORD })

    const [user] = await db.select().from(users).where(eq(users.email, TEST_EMAIL))
    expect(user).toBeDefined()
    expect(user!.roles).toEqual(['admin'])
    expect(user!.passwordHash).not.toBeNull()

    const [account] = await db
      .select()
      .from(baAccounts)
      .where(and(eq(baAccounts.userId, user!.id), eq(baAccounts.providerId, 'credential')))
    expect(account).toBeDefined()
    expect(account!.password).not.toBeNull()
    expect(account!.accountId).toBe(TEST_EMAIL)

    await cleanupSeed()
  })

  it('is idempotent on re-run: still exactly one user row and one credential row', async () => {
    await cleanupSeed()

    await seedAdmin({ email: TEST_EMAIL, password: TEST_PASSWORD })
    await seedAdmin({ email: TEST_EMAIL, password: TEST_PASSWORD })

    const userRows = await db.select().from(users).where(eq(users.email, TEST_EMAIL))
    expect(userRows).toHaveLength(1)

    const accountRows = await db
      .select()
      .from(baAccounts)
      .where(and(eq(baAccounts.userId, userRows[0]!.id), eq(baAccounts.providerId, 'credential')))
    expect(accountRows).toHaveLength(1)
    expect(accountRows[0]!.password).not.toBeNull()

    await cleanupSeed()
  })
})
