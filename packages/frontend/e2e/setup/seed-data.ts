import { execFileSync } from 'node:child_process'
import postgres from 'postgres'

export const TEST_USER = {
  email: 'test@hashhive.local',
  password: 'TestPassword123!',
  name: 'Test User',
} as const

export const TEST_PROJECT = {
  name: 'Test Project',
  slug: 'test-project',
} as const

/**
 * Hashes a password using Bun's built-in bcrypt via a subprocess.
 * Playwright runs under Node.js, so we delegate to Bun for bcrypt support.
 */
function hashPassword(password: string): string {
  const script = `
    const hash = await Bun.password.hash(${JSON.stringify(password)}, { algorithm: "bcrypt", cost: 12 });
    process.stdout.write(hash);
  `
  return execFileSync('bun', ['-e', script], { encoding: 'utf-8' })
}

/**
 * Seeds the test database with a user, project, and project membership.
 */
export async function seedTestData(databaseUrl: string): Promise<{
  userId: number
  projectId: number
}> {
  const sql = postgres(databaseUrl, { max: 1 })

  try {
    const passwordHash = hashPassword(TEST_USER.password)

    // Insert user
    const [user] = await sql`
      INSERT INTO users (email, password_hash, name, status, email_verified)
      VALUES (${TEST_USER.email}, ${passwordHash}, ${TEST_USER.name}, 'active', true)
      RETURNING id
    `
    if (!user) {
      throw new Error('Failed to insert test user')
    }
    const userId = user.id as number

    // Insert project
    const [project] = await sql`
      INSERT INTO projects (name, slug, created_by)
      VALUES (${TEST_PROJECT.name}, ${TEST_PROJECT.slug}, ${userId})
      RETURNING id
    `
    if (!project) {
      throw new Error('Failed to insert test project')
    }
    const projectId = project.id as number

    // Insert project membership with admin role
    await sql`
      INSERT INTO project_users (user_id, project_id, roles)
      VALUES (${userId}, ${projectId}, ${sql.array(['admin'])})
    `

    return { userId, projectId }
  } finally {
    await sql.end()
  }
}
