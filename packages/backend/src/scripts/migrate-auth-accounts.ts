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
 * `MigrateAuthAccountsCountMismatchError` on the post-migration consistency
 * check's failure, rather than calling `process.exit(2)` itself -- a test
 * process must never be killed by the function under test. The
 * `import.meta.main` CLI entrypoint below is what maps that thrown error
 * (and any other) to the original process-exit-code contract.
 */

import { baAccounts, users } from '@hashhive/shared'
import { isNotNull, sql } from 'drizzle-orm'

import { client, db } from '../db/index.js'

export interface MigrateAuthAccountsResult {
  migrated: number
  skipped: number
  accountCount: number
  userCount: number
}

/**
 * Thrown when the post-migration credential-account count does not match
 * the local-password user count -- a data-integrity signal that some users
 * may not be able to authenticate. Never silently ignored: the CLI
 * entrypoint maps this to exit code 2 (distinct from the generic
 * exit-1 "something else failed" case), matching the script's original
 * `process.exit(2)` contract.
 */
export class MigrateAuthAccountsCountMismatchError extends Error {
  constructor(
    public readonly accountCount: number,
    public readonly userCount: number
  ) {
    super(
      `Credential-account count (${accountCount}) does not match local-password user count (${userCount}). Some users may not be able to authenticate.`
    )
    this.name = 'MigrateAuthAccountsCountMismatchError'
  }
}

export async function migrateAuthAccounts(): Promise<MigrateAuthAccountsResult> {
  console.log('Starting BetterAuth account migration...')

  const allUsers = await db.select().from(users)
  console.log(`Found ${allUsers.length} users to migrate`)

  let migrated = 0
  let skipped = 0

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
        // throw off the account/user count check below). Their local-password
        // absence is exactly what the break-glass floor guard relies on.
        if (user.passwordHash === null) {
          skipped++
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
          skipped++
        }
      }
    })
  }

  console.log(`Migration complete: ${migrated} migrated, ${skipped} skipped (already existed)`)

  // Verify every LOCAL-password user got a credential account. Directory-only
  // users (null passwordHash) are excluded on both sides -- they authenticate
  // via their `ldap` account, not a `credential` one.
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

  if (accountCount !== userCount) {
    throw new MigrateAuthAccountsCountMismatchError(accountCount, userCount)
  }
  console.log(
    `Verified: ${accountCount} credential accounts match ${userCount} local-password users`
  )

  return { migrated, skipped, accountCount, userCount }
}

if (import.meta.main) {
  migrateAuthAccounts()
    .then(async () => {
      await client.end()
    })
    .catch(async (err) => {
      console.error('Migration failed:', err)
      await client.end()
      process.exit(err instanceof MigrateAuthAccountsCountMismatchError ? 2 : 1)
    })
}
