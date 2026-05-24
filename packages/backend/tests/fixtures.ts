/**
 * Test fixtures and factory functions for creating test data.
 *
 * These factories produce plain objects matching Drizzle insert schemas.
 * For unit tests that don't hit the database, use the objects directly.
 * For integration tests, pass them to Drizzle `db.insert()`.
 */
import type {
  InsertAgent,
  InsertAttack,
  InsertCampaign,
  InsertHashItem,
  InsertHashList,
  InsertHashType,
  InsertProject,
  InsertTask,
  InsertUser,
} from '@hashhive/shared'

let counter = 0
function nextId() {
  return ++counter
}

/** Reset the counter between test suites if needed. */
export function resetFixtures() {
  counter = 0
}

// ─── Users ──────────────────────────────────────────────────────────

export function buildUser(overrides: Partial<InsertUser> = {}): InsertUser {
  const n = nextId()
  return {
    email: `user-${n}@test.local`,
    passwordHash: '$2b$12$dummyHashForTesting000000000000000000000000000000',
    name: `Test User ${n}`,
    status: 'active',
    ...overrides,
  }
}

// ─── Projects ───────────────────────────────────────────────────────

export function buildProject(overrides: Partial<InsertProject> = {}): InsertProject {
  const n = nextId()
  return {
    name: `Test Project ${n}`,
    slug: `test-project-${n}`,
    ...overrides,
  }
}

// ─── Agents ─────────────────────────────────────────────────────────

export function buildAgent(overrides: Partial<InsertAgent> & { projectId: number }): InsertAgent {
  const n = nextId()
  return {
    name: `Agent ${n}`,
    authToken: `test-agent-token-${n}-${crypto.randomUUID()}`,
    status: 'offline',
    ...overrides,
  }
}

// ─── Hash Types ─────────────────────────────────────────────────────

export function buildHashType(overrides: Partial<InsertHashType> = {}): InsertHashType {
  const n = nextId()
  return {
    name: `Hash Type ${n}`,
    hashcatMode: 10000 + n,
    category: 'Test',
    ...overrides,
  }
}

// ─── Hash Lists ─────────────────────────────────────────────────────

export function buildHashList(
  overrides: Partial<InsertHashList> & { projectId: number }
): InsertHashList {
  const n = nextId()
  return {
    name: `Hash List ${n}`,
    source: 'upload',
    status: 'ready',
    ...overrides,
  }
}

// ─── Hash Items ─────────────────────────────────────────────────────

export function buildHashItem(
  overrides: Partial<InsertHashItem> & { hashListId: number }
): InsertHashItem {
  const n = nextId()
  return {
    hashValue: `${n}d41402abc4b2a76b9719d911017c592`.slice(0, 32),
    ...overrides,
  }
}

// ─── Campaigns ──────────────────────────────────────────────────────

export function buildCampaign(
  overrides: Partial<InsertCampaign> & { projectId: number; hashListId: number }
): InsertCampaign {
  const n = nextId()
  return {
    name: `Campaign ${n}`,
    status: 'draft',
    priority: 5,
    ...overrides,
  }
}

// ─── Attacks ────────────────────────────────────────────────────────

export function buildAttack(
  overrides: Partial<InsertAttack> & { campaignId: number; projectId: number }
): InsertAttack {
  return {
    mode: 0,
    status: 'pending',
    ...overrides,
  }
}

// ─── Tasks ──────────────────────────────────────────────────────────

export function buildTask(
  overrides: Partial<InsertTask> & { attackId: number; campaignId: number }
): InsertTask {
  return {
    status: 'pending',
    ...overrides,
  }
}

// ─── Token Helpers ──────────────────────────────────────────────────

/**
 * Return a pre-shared agent token for agent API testing.
 *
 * For unit/contract tests without a database, pass a mock token string.
 * For integration tests with a seeded database, pass the agent's actual authToken.
 */
export function agentToken(token = 'test-agent-preshared-token'): string {
  return token
}
