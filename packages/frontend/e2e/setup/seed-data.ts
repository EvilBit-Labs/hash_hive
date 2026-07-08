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
 * A seeded hash list + campaign so e2e can reach the campaign-detail page
 * (Radix Tabs) and the hash-list-detail page (Radix ToggleGroup), both of
 * which require real entities to render. Referenced by `radix-primitives.spec`.
 */
export const TEST_HASH_LIST = { name: 'E2E Seed List' } as const
export const TEST_CAMPAIGN = { name: 'E2E Seed Campaign' } as const

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

    // Seed a hash type -> hash list -> campaign chain so the campaign-detail
    // (Radix Tabs) and hash-list-detail (Radix ToggleGroup) surfaces render in
    // e2e. Column shape mirrors the backend db-test factories.
    const [hashType] = await sql`
      INSERT INTO hash_types (name, hashcat_mode)
      VALUES ('MD5 (e2e seed)', 0)
      RETURNING id
    `
    if (!hashType || typeof hashType['id'] !== 'number') {
      throw new Error('Failed to insert seed hash type')
    }
    const [hashList] = await sql`
      INSERT INTO hash_lists (project_id, name, hash_type_id, status)
      VALUES (${projectId}, ${TEST_HASH_LIST.name}, ${hashType['id']}, 'ready')
      RETURNING id
    `
    if (!hashList || typeof hashList['id'] !== 'number') {
      throw new Error('Failed to insert seed hash list')
    }
    // hashcat_mode is latched here to match the attack inserted below (mode
    // 0) — the single-hash-mode-per-campaign DB backstop (issue #100) FKs
    // attacks(campaign_id, mode) to campaigns(id, hashcat_mode), so every
    // attack this campaign ever owns must agree with this value.
    const [campaign] = await sql`
      INSERT INTO campaigns (name, project_id, hash_list_id, priority, status, is_permanent, hashcat_mode)
      VALUES (${TEST_CAMPAIGN.name}, ${projectId}, ${hashList['id']}, 5, 'running', true, 0)
      RETURNING id
    `
    if (!campaign || typeof campaign['id'] !== 'number') {
      throw new Error('Failed to insert seed campaign')
    }
    // The campaign lifecycle invariant is "Start requires >=1 attack", so a
    // running campaign must own at least one attack. Seed a minimal dictionary
    // attack (mode 0) so the fixture matches a valid production state.
    await sql`
      INSERT INTO attacks (campaign_id, project_id, mode)
      VALUES (${campaign['id']}, ${projectId}, 0)
    `

    return { userId, projectId }
  } finally {
    await sql.end()
  }
}
