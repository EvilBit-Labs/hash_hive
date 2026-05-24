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
import { sql } from 'drizzle-orm'

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

  // Verify counts match
  const [accountCount] = await db.select({ count: sql<number>`count(*)::int` }).from(baAccounts)
  const [userCount] = await db.select({ count: sql<number>`count(*)::int` }).from(users)

  if (accountCount?.count !== userCount?.count) {
    console.error(
      `FATAL: Account count (${accountCount?.count}) does not match user count (${userCount?.count}). ` +
        'Some users may not be able to authenticate. Investigate before deploying.'
    )
    process.exit(2)
  }
  console.log(`Verified: ${accountCount?.count} accounts match ${userCount?.count} users`)
}

migrateAuthAccounts().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
