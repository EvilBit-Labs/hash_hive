/**
 * Real-DB tests for the break-glass migration script
 * (`migrate-auth-accounts.ts`): copies existing local-password users'
 * bcrypt hashes into a `ba_accounts` credential row so BetterAuth can
 * authenticate them, while explicitly skipping directory-only
 * (null-`passwordHash`) users so they never get an inert credential row.
 *
 * Before this test existed, the script was never exercised by any test --
 * a regression here (e.g. forgetting the `passwordHash === null` skip, or
 * the post-migration count check) could silently ship a broken migration.
 *
 * `migrateAuthAccounts()` was refactored to THROW
 * `MigrateAuthAccountsCountMismatchError` instead of calling
 * `process.exit(2)` directly specifically so it is safe to call from a
 * test process -- see the script's module doc.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts) against the
 * isolated `hashhive_test` database. `migrateAuthAccounts()` operates over
 * every `users` row with no scoping (matching its real CLI behavior), so
 * this file relies on the same "every other tests/db file cleans up its
 * own seed rows in afterAll before the next file runs" convention the rest
 * of this lane already depends on (`bun test tests/db` runs files
 * sequentially).
 *
 * NOTE: do NOT call `client.end()` here -- `harness.test.ts` owns the
 * shared drizzle client lifecycle. NOTE: do NOT self-skip -- the test-db
 * lane always has Postgres available.
 */

import { baAccounts, users } from '@hashhive/shared'
import { afterAll, describe, expect, it } from 'bun:test'
import { and, eq, like } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { migrateAuthAccounts } from '../../src/scripts/migrate-auth-accounts.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const EMAIL_DOMAIN = 'migrate-auth-accounts-db-test.hashhive.local'

// ─── Seed helpers ───────────────────────────────────────────────────────────

async function cleanupSeed(): Promise<void> {
  await db.delete(users).where(like(users.email, `%@${EMAIL_DOMAIN}`))
}

// ─── Suite ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  await cleanupSeed()
})

describe('migrateAuthAccounts', () => {
  it('creates a credential row for a local-password user, none for a directory-only user, and the count check passes', async () => {
    await cleanupSeed()

    const [localUser] = await db
      .insert(users)
      .values({
        email: `local-password@${EMAIL_DOMAIN}`,
        passwordHash: 'bcrypt-hash-placeholder-local',
        name: 'Migrate Test - Local',
        roles: ['analyst'],
      })
      .returning({ id: users.id })

    const [directoryUser] = await db
      .insert(users)
      .values({
        email: `directory-only@${EMAIL_DOMAIN}`,
        passwordHash: null,
        name: 'Migrate Test - Directory',
        roles: ['analyst'],
      })
      .returning({ id: users.id })

    const result = await migrateAuthAccounts()
    expect(result.migrated).toBeGreaterThanOrEqual(1)
    expect(result.accountCount).toBe(result.userCount)

    const [localAccount] = await db
      .select()
      .from(baAccounts)
      .where(and(eq(baAccounts.userId, localUser!.id), eq(baAccounts.providerId, 'credential')))
    expect(localAccount).toBeDefined()
    expect(localAccount!.password).toBe('bcrypt-hash-placeholder-local')

    const directoryAccounts = await db
      .select()
      .from(baAccounts)
      .where(eq(baAccounts.userId, directoryUser!.id))
    expect(directoryAccounts).toHaveLength(0)

    // emailVerified is flipped true for every user as part of the migration
    // (air-gapped deployment, no email verification step) -- including the
    // directory-only user, which does not affect its credential-row exclusion.
    const [directoryRow] = await db.select().from(users).where(eq(users.id, directoryUser!.id))
    expect(directoryRow!.emailVerified).toBe(true)

    await cleanupSeed()
  })

  it('is idempotent on re-run: no duplicate credential rows, still passes the count check', async () => {
    await cleanupSeed()

    const [localUser] = await db
      .insert(users)
      .values({
        email: `idempotent@${EMAIL_DOMAIN}`,
        passwordHash: 'bcrypt-hash-placeholder-idempotent',
        name: 'Migrate Test - Idempotent',
        roles: ['analyst'],
      })
      .returning({ id: users.id })

    await migrateAuthAccounts()
    const second = await migrateAuthAccounts()
    expect(second.accountCount).toBe(second.userCount)

    const accounts = await db
      .select()
      .from(baAccounts)
      .where(and(eq(baAccounts.userId, localUser!.id), eq(baAccounts.providerId, 'credential')))
    expect(accounts).toHaveLength(1)

    await cleanupSeed()
  })
})
