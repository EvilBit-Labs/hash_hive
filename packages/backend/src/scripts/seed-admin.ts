/**
 * Seed script: creates an admin user and default project.
 *
 * Usage:
 *   bun packages/backend/src/scripts/seed-admin.ts
 *   just db-seed
 */
import { projects, projectUsers, users } from '@hashhive/shared';
import { eq } from 'drizzle-orm';
import { client, db } from '../db/index.js';
import { hashPassword } from '../services/auth.js';

const ADMIN_EMAIL = 'admin@hashhive.local';
const ADMIN_PASSWORD = 'changeme123';
const ADMIN_NAME = 'Admin';
const PROJECT_NAME = 'Default Project';
const PROJECT_SLUG = 'default';

async function seed() {
  // Check if admin already exists
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);

  if (existing.length > 0) {
    console.log(`Admin user already exists (${ADMIN_EMAIL})`);
    await client.end();
    return;
  }

  const passwordHash = await hashPassword(ADMIN_PASSWORD);

  const [user] = await db
    .insert(users)
    .values({ email: ADMIN_EMAIL, passwordHash, name: ADMIN_NAME })
    .returning({ id: users.id });

  if (!user) {
    console.error('Failed to create admin user');
    await client.end();
    process.exit(1);
  }

  const [project] = await db
    .insert(projects)
    .values({
      name: PROJECT_NAME,
      slug: PROJECT_SLUG,
      createdBy: user.id,
    })
    .returning({ id: projects.id });

  if (!project) {
    console.error('Failed to create default project');
    await client.end();
    process.exit(1);
  }

  await db.insert(projectUsers).values({
    userId: user.id,
    projectId: project.id,
    roles: ['admin'],
  });

  console.log('Seed complete:');
  console.log(`  Email:    ${ADMIN_EMAIL}`);
  console.log(`  Password: ${ADMIN_PASSWORD}`);
  console.log(`  Project:  ${PROJECT_NAME}`);

  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
