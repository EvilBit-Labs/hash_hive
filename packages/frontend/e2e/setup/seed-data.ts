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

export const TEST_PROJECT_SECONDARY = {
  name: 'Secondary Project',
  slug: 'secondary-project',
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
    if (!user || typeof user['id'] !== 'number') {
      throw new Error('Failed to insert test user')
    }
    const userId = user['id']

    // Insert project
    const [project] = await sql`
      INSERT INTO projects (name, slug, created_by)
      VALUES (${TEST_PROJECT.name}, ${TEST_PROJECT.slug}, ${userId})
      RETURNING id
    `
    if (!project || typeof project['id'] !== 'number') {
      throw new Error('Failed to insert test project')
    }
    const projectId = project['id']

    // Insert project membership with admin role
    await sql`
      INSERT INTO project_users (user_id, project_id, roles)
      VALUES (${userId}, ${projectId}, ${sql.array(['admin'])})
    `

    // Seed a second project + membership so e2e covers the multi-project
    // selector flow (issue #160 AC §2). Single-project users would
    // bypass the selector via syncSelectedProject's auto-select.
    const [secondaryProject] = await sql`
      INSERT INTO projects (name, slug, created_by)
      VALUES (${TEST_PROJECT_SECONDARY.name}, ${TEST_PROJECT_SECONDARY.slug}, ${userId})
      RETURNING id
    `
    if (!secondaryProject || typeof secondaryProject['id'] !== 'number') {
      throw new Error('Failed to insert secondary test project')
    }
    await sql`
      INSERT INTO project_users (user_id, project_id, roles)
      VALUES (${userId}, ${secondaryProject['id']}, ${sql.array(['operator'])})
    `

    // Seed one offline agent into the primary test project. The dashboard's
    // onboarding hero swaps in when `agents.total === 0`, replacing the
    // four StatCards that several e2e specs assert against (`zz-dashboard`
    // expects `data-testid="stat-card"` × 4). One row, status='offline', is
    // enough to keep the bento mounted across the e2e suite without
    // implying the agent is actually serving work.
    await sql`
      INSERT INTO agents (name, project_id, status, auth_token_format)
      VALUES ('E2E Seed Agent', ${projectId}, 'offline', 'plaintext')
    `

    return { userId, projectId }
  } finally {
    await sql.end()
  }
}
