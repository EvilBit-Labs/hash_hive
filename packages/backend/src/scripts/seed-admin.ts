/**
 * Seed script: creates an admin user and default project.
 *
 * Idempotent — safe to re-run. Missing user, project, or membership
 * rows are reconciled inside a single transaction.
 *
 * Override credentials via environment variables:
 *   SEED_ADMIN_EMAIL    (default: admin@hashhive.local)
 *   SEED_ADMIN_PASSWORD (default: changeme123)
 *
 * Usage:
 *   bun packages/backend/src/scripts/seed-admin.ts
 *   just db-seed
 */
import { projects, projectUsers, users } from '@hashhive/shared';
import { client, db } from '../db/index.js';
import { hashPassword } from '../services/auth.js';

const ADMIN_EMAIL = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@hashhive.local';
const ADMIN_PASSWORD = process.env['SEED_ADMIN_PASSWORD'] ?? 'changeme123';
const ADMIN_NAME = 'Admin';
const PROJECT_NAME = 'Default Project';
const PROJECT_SLUG = 'default';

async function seed() {
  const passwordHash = await hashPassword(ADMIN_PASSWORD);

  await db.transaction(async (tx) => {
    // Find-or-create admin user (email has a unique constraint)
    const [user] = await tx
      .insert(users)
      .values({ email: ADMIN_EMAIL, passwordHash, name: ADMIN_NAME })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: ADMIN_NAME, passwordHash },
      })
      .returning({ id: users.id });

    if (!user) {
      throw new Error('Failed to upsert admin user');
    }

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
      .returning({ id: projects.id });

    if (!project) {
      throw new Error('Failed to upsert default project');
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
      });

    console.log('Seed complete:');
    console.log(`  Email:   ${ADMIN_EMAIL}`);
    console.log(`  Project: ${PROJECT_NAME}`);
  });

  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
