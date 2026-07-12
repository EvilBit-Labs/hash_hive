/**
 * Data migration: Copy existing user credentials to BetterAuth ba_accounts table.
 *
 * This script creates credential account rows for each existing user so that
 * BetterAuth can authenticate them using their existing bcrypt password hashes.
 *
 * Idempotent: uses INSERT ... ON CONFLICT DO NOTHING.
 * Run in a transaction to ensure atomicity.
 *
 * Usage: bun packages/backend/src/scripts/migrate-auth-accounts.ts
 *
 * `migrateAuthAccounts()` is exported so `tests/db/migrate-auth-accounts.db.test.ts`
 * can exercise it directly. It returns a summary and THROWS
 * `MigrateAuthAccountsMissingCredentialError` on the post-migration
 * consistency check's failure, rather than calling `process.exit(2)`
 * itself -- a test process must never be killed by the function under
 * test. The `import.meta.main` CLI entrypoint below is what maps that
 * thrown error (and any other) to the original process-exit-code contract.
 *
 * The post-migration check is PER-USER (an anti-join: every user with a
 * non-null `passwordHash` must have a matching `credential` `ba_accounts`
 * row with a non-null password), not an aggregate count comparison --
 * comparing `count(credential accounts)` to `count(local-password users)`
 * can coincidentally match even when a SPECIFIC local-password user has no
 * credential row (e.g. one user's insert was skipped for an unrelated
 * reason while a stale/unrelated row inflates the account count by
 * coincidence), silently passing a broken migration for that user
 * (code review FIX 6).
 */

import { baAccounts, users } from '@hashhive/shared'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'

import { client, db } from '../db/index.js'

export interface MigrateAuthAccountsResult {
  migrated: number
  /** Directory-only users (null passwordHash) -- never get a credential row. */
  skippedDirectoryOnly: number
  /** Local-password users that already had a credential row (idempotent re-run). */
  skippedExisting: number
  accountCount: number
  userCount: number
}

/**
 * Thrown when the per-user post-migration check finds a local-password user
 * (non-null `passwordHash`) with no matching `credential` `ba_accounts` row
 * -- a data-integrity signal that user may not be able to authenticate.
 * Never silently ignored: the CLI entrypoint maps this to exit code 2
 * (distinct from the generic exit-1 "something else failed" case), matching
 * the script's original `process.exit(2)` contract.
 */
export class MigrateAuthAccountsMissingCredentialError extends Error {
  constructor(public readonly missingUserIds: readonly number[]) {
    super(
      `${missingUserIds.length} local-password user(s) have no matching credential account: [${missingUserIds.join(', ')}]. These users may not be able to authenticate.`
    )
    this.name = 'MigrateAuthAccountsMissingCredentialError'
  }
}

export async function migrateAuthAccounts(): Promise<MigrateAuthAccountsResult> {
  console.log('Starting BetterAuth account migration...')

  const allUsers = await db.select().from(users)
  console.log(`Found ${allUsers.length} users to migrate`)

  let migrated = 0
  let skippedDirectoryOnly = 0
  let skippedExisting = 0

  if (allUsers.length === 0) {
    console.log('No users to migrate.')
  } else {
    await db.transaction(async (tx) => {
      // Set emailVerified = true for all existing users (air-gapped, no email verification)
      await tx.update(users).set({ emailVerified: true })

      for (const user of allUsers) {
        // Directory-only users (JIT-provisioned via LDAP) have a null
        // passwordHash and no local password -- they must NOT get a
        // `credential` row (a null-password one is inert but noise, and would
        // throw off the per-user check below). Their local-password
        // absence is exactly what the break-glass floor guard relies on.
        if (user.passwordHash === null) {
          skippedDirectoryOnly++
          continue
        }

        const result = await tx
          .insert(baAccounts)
          .values({
            id: crypto.randomUUID(),
            userId: user.id,
            accountId: user.email,
            providerId: 'credential',
            password: user.passwordHash,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          })
          .onConflictDoNothing({
            target: [baAccounts.userId, baAccounts.providerId],
          })
          .returning({ id: baAccounts.id })

        if (result.length > 0) {
          migrated++
        } else {
          skippedExisting++
        }
      }
    })
  }

  console.log(
    `Migration complete: ${migrated} migrated, ${skippedDirectoryOnly} skipped (directory-only, no local password), ${skippedExisting} skipped (credential account already existed)`
  )

  // Verify every LOCAL-password user got a credential account -- PER USER
  // (an anti-join), not an aggregate count comparison (code review FIX 6):
  // an aggregate count can coincidentally match while a specific
  // local-password user has no credential row. Directory-only users (null
  // passwordHash) are excluded -- they authenticate via their `ldap`
  // account, not a `credential` one.
  const missingCredentialRows = await db
    .select({ id: users.id })
    .from(users)
    .leftJoin(
      baAccounts,
      and(
        eq(baAccounts.userId, users.id),
        eq(baAccounts.providerId, 'credential'),
        isNotNull(baAccounts.password)
      )
    )
    .where(and(isNotNull(users.passwordHash), isNull(baAccounts.id)))

  if (missingCredentialRows.length > 0) {
    throw new MigrateAuthAccountsMissingCredentialError(missingCredentialRows.map((row) => row.id))
  }

  // Diagnostic-only counts (not the pass/fail signal above) -- kept in the
  // returned summary for CLI/log visibility and existing test assertions.
  const [accountCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(baAccounts)
    .where(sql`${baAccounts.providerId} = 'credential' and ${baAccounts.password} is not null`)
  const [userCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(isNotNull(users.passwordHash))

  const accountCount = accountCountRow?.count ?? 0
  const userCount = userCountRow?.count ?? 0

  console.log(
    `Verified: every local-password user has a matching credential account (${accountCount} credential accounts, ${userCount} local-password users)`
  )

  return { migrated, skippedDirectoryOnly, skippedExisting, accountCount, userCount }
}

if (import.meta.main) {
  migrateAuthAccounts()
    .then(async () => {
      await client.end()
    })
    .catch(async (err) => {
      console.error('Migration failed:', err)
      await client.end()
      process.exit(err instanceof MigrateAuthAccountsMissingCredentialError ? 2 : 1)
    })
}
