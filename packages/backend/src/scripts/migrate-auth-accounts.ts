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
 */

import { baAccounts, users } from '@hashhive/shared'
import { isNotNull, sql } from 'drizzle-orm'

import { db } from '../db/index.js'

async function migrateAuthAccounts() {
  console.log('Starting BetterAuth account migration...')

  const allUsers = await db.select().from(users)
  console.log(`Found ${allUsers.length} users to migrate`)

  if (allUsers.length === 0) {
    console.log('No users to migrate. Done.')
    return
  }

  let migrated = 0
  let skipped = 0

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

  console.log(`Migration complete: ${migrated} migrated, ${skipped} skipped (already existed)`)

  // Verify every LOCAL-password user got a credential account. Directory-only
  // users (null passwordHash) are excluded on both sides -- they authenticate
  // via their `ldap` account, not a `credential` one.
  const [accountCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(baAccounts)
    .where(sql`${baAccounts.providerId} = 'credential' and ${baAccounts.password} is not null`)
  const [userCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(isNotNull(users.passwordHash))

  if (accountCount?.count !== userCount?.count) {
    console.error(
      `FATAL: Credential-account count (${accountCount?.count}) does not match ` +
        `local-password user count (${userCount?.count}). ` +
        'Some users may not be able to authenticate. Investigate before deploying.'
    )
    process.exit(2)
  }
  console.log(
    `Verified: ${accountCount?.count} credential accounts match ${userCount?.count} local-password users`
  )
}

migrateAuthAccounts().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
