/**
 * Branch coverage for `computeInitialSessionProjectId` (issue #159 U3),
 * the helper that backs BetterAuth's `databaseHooks.session.create.before`.
 *
 * mock.module() MUST be called before importing the SUT so the
 * BetterAuth bootstrap doesn't pull a real DB client. See
 * docs/solutions/bun-test-mock-module-import-order-taxonomy.md.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── Mock service layer ──────────────────────────────────────────────

type ProjectsRow = { id: number; name: string; slug: string; roles: string[] }
type UserWithProjects = {
  user: { id: number; email: string; name: string; status: string; roles: string[] }
  projects: ProjectsRow[]
} | null

let mockUserWithProjects: UserWithProjects = null
let mockUserWithProjectsThrows: Error | null = null

let mockLastProjectId: number | null = null
let mockLastProjectIdThrows: Error | null = null

let mockMembership: { id: number; userId: number; projectId: number; roles: string[] } | null = null
let mockMembershipThrows: Error | null = null

mock.module('../../../src/services/auth.js', () => ({
  getUserWithProjects: async (_userId: number): Promise<UserWithProjects> => {
    if (mockUserWithProjectsThrows) throw mockUserWithProjectsThrows
    return mockUserWithProjects
  },
  getUserLastProjectId: async (_userId: number): Promise<number | null> => {
    if (mockLastProjectIdThrows) throw mockLastProjectIdThrows
    return mockLastProjectId
  },
  findProjectMembership: async (_userId: number, _projectId: number) => {
    if (mockMembershipThrows) throw mockMembershipThrows
    return mockMembership
  },
}))

// Stub DB so BetterAuth's drizzleAdapter bootstrap doesn't open a connection.
mock.module('../../../src/db/index.js', () => ({
  db: {} as never,
  client: {},
}))

import { computeInitialSessionProjectId } from '../../../src/lib/auth.js'

function makeUser(projectIds: number[]): UserWithProjects {
  return {
    user: { id: 1, email: 'u@test', name: 'U', status: 'active', roles: ['admin'] },
    projects: projectIds.map((id) => ({
      id,
      name: `P${id}`,
      slug: `p${id}`,
      roles: ['admin'],
    })),
  }
}

describe('computeInitialSessionProjectId', () => {
  beforeEach(() => {
    mockUserWithProjects = null
    mockUserWithProjectsThrows = null
    mockLastProjectId = null
    mockLastProjectIdThrows = null
    mockMembership = null
    mockMembershipThrows = null
  })

  it('returns null for non-positive userIds (defensive)', async () => {
    expect(await computeInitialSessionProjectId(0)).toBeNull()
    expect(await computeInitialSessionProjectId(-1)).toBeNull()
    expect(await computeInitialSessionProjectId(Number.NaN)).toBeNull()
    expect(await computeInitialSessionProjectId(1.5)).toBeNull()
  })

  it('returns null when getUserWithProjects throws (operator-visible incident)', async () => {
    mockUserWithProjectsThrows = new Error('connection refused')
    expect(await computeInitialSessionProjectId(1)).toBeNull()
  })

  it('returns null when the user is not found', async () => {
    mockUserWithProjects = null
    expect(await computeInitialSessionProjectId(1)).toBeNull()
  })

  it('returns null when the user has zero project memberships', async () => {
    mockUserWithProjects = makeUser([])
    expect(await computeInitialSessionProjectId(1)).toBeNull()
  })

  describe('branch 1: single-project auto-select', () => {
    it('returns the single project id (wins over preference)', async () => {
      mockUserWithProjects = makeUser([42])
      // Even with a different last_project_id set, single-project wins.
      mockLastProjectId = 99
      expect(await computeInitialSessionProjectId(1)).toBe(42)
    })
  })

  describe('branch 2: last_project_id rehydrate (multi-project)', () => {
    it('returns last_project_id when membership is still valid', async () => {
      mockUserWithProjects = makeUser([10, 20, 30])
      mockLastProjectId = 20
      mockMembership = { id: 1, userId: 1, projectId: 20, roles: ['admin'] }
      expect(await computeInitialSessionProjectId(1)).toBe(20)
    })

    it('returns null when last_project_id is unset (multi-project user, no preference yet)', async () => {
      mockUserWithProjects = makeUser([10, 20])
      mockLastProjectId = null
      expect(await computeInitialSessionProjectId(1)).toBeNull()
    })

    it('returns null when membership was revoked (must NOT silently reattach)', async () => {
      mockUserWithProjects = makeUser([10, 20])
      mockLastProjectId = 99 // user no longer in P99
      mockMembership = null
      expect(await computeInitialSessionProjectId(1)).toBeNull()
    })

    it('returns null when getUserLastProjectId throws', async () => {
      mockUserWithProjects = makeUser([10, 20])
      mockLastProjectIdThrows = new Error('db down')
      expect(await computeInitialSessionProjectId(1)).toBeNull()
    })

    it('returns null when findProjectMembership throws', async () => {
      mockUserWithProjects = makeUser([10, 20])
      mockLastProjectId = 20
      mockMembershipThrows = new Error('db down')
      expect(await computeInitialSessionProjectId(1)).toBeNull()
    })
  })
})
