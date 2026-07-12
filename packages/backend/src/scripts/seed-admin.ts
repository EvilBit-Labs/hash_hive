/**
 * Seed script: creates an admin user and default project.
 *
 * Idempotent — safe to re-run. Missing user, project, or membership
 * rows are reconciled inside a single transaction.
 *
 * Break-glass guarantee (U6b, docs/plans/2026-07-12-001-feat-adldap-authentication-support-plan.md):
 * this script writes a `ba_accounts` credential row (`providerId:
 * 'credential'`, a non-null bcrypt password) for the seeded admin, not just
 * `users.passwordHash`. Per KTD3, that `ba_accounts` credential row -- not
 * `users.passwordHash` -- is the authoritative "has a local password" test
 * `assertLocalAdminRemains` (`services/local-admin-guard.ts`) reads. Without
 * it, a fresh deployment would seed an admin with `roles: ['admin']` that
 * does NOT count toward the local-admin floor and, on some environments,
 * cannot sign in via BetterAuth's `/sign-in/email` at all (BetterAuth
 * authenticates against `ba_accounts`, never `users.passwordHash`
 * directly) -- an empty break-glass floor from the very first seed. Kept
 * idempotent and in the same transaction as the user upsert so a re-seed
 * also refreshes the credential row's password, matching how `roles` and
 * `passwordHash` are already reaffirmed below. `migrate-auth-accounts.ts`
 * (chained immediately after this script in `db:seed`) still runs safely
 * afterward for every OTHER user; its `onConflictDoNothing` means it is a
 * no-op for this row once this script has already created it.
 *
 * Override credentials via environment variables:
 *   SEED_ADMIN_EMAIL    (default: admin@hashhive.local)
 *   SEED_ADMIN_PASSWORD (default: changeme123)
 *
 * Usage:
 *   bun packages/backend/src/scripts/seed-admin.ts
 *   just db-seed
 */
import { baAccounts, projects, projectUsers, users } from '@hashhive/shared'

import { client, db } from '../db/index.js'

const ADMIN_EMAIL = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@hashhive.local'
const ADMIN_PASSWORD = process.env['SEED_ADMIN_PASSWORD'] ?? 'changeme123'
const ADMIN_NAME = 'Admin'
const PROJECT_NAME = 'Default Project'
const PROJECT_SLUG = 'default'

async function seed() {
  const passwordHash = await Bun.password.hash(ADMIN_PASSWORD, { algorithm: 'bcrypt', cost: 12 })

  await db.transaction(async (tx) => {
    // Find-or-create admin user (email has a unique constraint).
    // `roles` is set explicitly on both insert and update branches so the
    // 'analyst' column default (least-privileged tier for safety) never
    // overrides the seed's intent, and re-seeds reaffirm admin tier if
    // it was manually downgraded.
    const [user] = await tx
      .insert(users)
      .values({ email: ADMIN_EMAIL, passwordHash, name: ADMIN_NAME, roles: ['admin'] })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: ADMIN_NAME, passwordHash, roles: ['admin'] },
      })
      .returning({ id: users.id })

    if (!user) {
      throw new Error('Failed to upsert admin user')
    }

    // Guarantee the seeded admin is a genuine LOCAL admin per KTD3 (see
    // module doc): upsert the `ba_accounts` credential row directly, rather
    // than relying on `migrate-auth-accounts.ts` running afterward. Uses
    // the same unique index (`userId`, `providerId`) that script upserts
    // against, so re-running either script stays idempotent and consistent.
    await tx
      .insert(baAccounts)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        accountId: ADMIN_EMAIL,
        providerId: 'credential',
        password: passwordHash,
      })
      .onConflictDoUpdate({
        target: [baAccounts.userId, baAccounts.providerId],
        set: { accountId: ADMIN_EMAIL, password: passwordHash },
      })

    // Find-or-create default project (slug has a unique constraint)
    const [project] = await tx
      .insert(projects)
      .values({
        name: PROJECT_NAME,
        slug: PROJECT_SLUG,
        createdBy: user.id,
      })
      .onConflictDoUpdate({
        target: projects.slug,
        set: { name: PROJECT_NAME },
      })
      .returning({ id: projects.id })

    if (!project) {
      throw new Error('Failed to upsert default project')
    }

    // Find-or-create project membership (unique index on userId + projectId)
    await tx
      .insert(projectUsers)
      .values({
        userId: user.id,
        projectId: project.id,
        roles: ['admin'],
      })
      .onConflictDoUpdate({
        target: [projectUsers.userId, projectUsers.projectId],
        set: { roles: ['admin'] },
      })

    console.log('Seed complete:')
    console.log(`  Email:   ${ADMIN_EMAIL}`)
    console.log(`  Project: ${PROJECT_NAME}`)
  })

  await client.end()
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
