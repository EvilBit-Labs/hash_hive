import { meResponseSchema, sessionUserSchema, userRoleSchema } from '@hashhive/shared'
/**
 * Wire-shape contracts for the dashboard session surface (issue #159 U2).
 * These schemas live in `@hashhive/shared` per AGENTS.md so backend and
 * frontend speak the same types -- the tests here lock the boundary.
 */
import { describe, expect, test } from 'bun:test'

describe('userRoleSchema', () => {
  test.each(['admin', 'operator', 'analyst'] as const)('accepts %s', (role) => {
    expect(userRoleSchema.parse(role)).toBe(role)
  })

  test('rejects per-project role names (cross-vocabulary guard)', () => {
    // 'viewer' and 'contributor' are valid per-project roles
    // (project_users.roles) but must NOT be global capability tiers.
    expect(() => userRoleSchema.parse('viewer')).toThrow()
    expect(() => userRoleSchema.parse('contributor')).toThrow()
  })

  test('rejects unknown values', () => {
    expect(() => userRoleSchema.parse('superuser')).toThrow()
    expect(() => userRoleSchema.parse('')).toThrow()
  })
})

describe('sessionUserSchema', () => {
  test('accepts a valid session with null selectedProjectId', () => {
    const parsed = sessionUserSchema.parse({
      userId: 1,
      email: 'admin@example.com',
      roles: ['admin'],
      selectedProjectId: null,
    })
    expect(parsed.selectedProjectId).toBeNull()
    expect(parsed.roles).toEqual(['admin'])
  })

  test('accepts a positive integer selectedProjectId', () => {
    const parsed = sessionUserSchema.parse({
      userId: 7,
      email: 'op@example.com',
      roles: ['operator', 'analyst'],
      selectedProjectId: 42,
    })
    expect(parsed.selectedProjectId).toBe(42)
  })

  test('rejects empty roles array', () => {
    expect(() =>
      sessionUserSchema.parse({
        userId: 1,
        email: 'x@y.test',
        roles: [],
        selectedProjectId: null,
      })
    ).toThrow()
  })

  test('rejects non-positive selectedProjectId', () => {
    const base = {
      userId: 1,
      email: 'x@y.test',
      roles: ['analyst'] as const,
    }
    expect(() => sessionUserSchema.parse({ ...base, selectedProjectId: 0 })).toThrow()
    expect(() => sessionUserSchema.parse({ ...base, selectedProjectId: -1 })).toThrow()
  })

  test('rejects non-positive userId', () => {
    expect(() =>
      sessionUserSchema.parse({
        userId: 0,
        email: 'x@y.test',
        roles: ['analyst'],
        selectedProjectId: null,
      })
    ).toThrow()
  })
})

describe('meResponseSchema', () => {
  const validPayload = {
    user: {
      id: 1,
      email: 'admin@example.com',
      name: 'Admin',
      status: 'active',
      roles: ['admin'],
    },
    projects: [
      { id: 1, name: 'P1', slug: 'p1', roles: ['admin'] },
      { id: 2, name: 'P2', slug: 'p2', roles: ['viewer'] },
    ],
    selectedProjectId: 1,
  }

  test('accepts a fully populated response', () => {
    const parsed = meResponseSchema.parse(validPayload)
    expect(parsed.selectedProjectId).toBe(1)
    expect(parsed.projects).toHaveLength(2)
  })

  test('accepts a multi-project user with no selection', () => {
    const parsed = meResponseSchema.parse({
      ...validPayload,
      selectedProjectId: null,
    })
    expect(parsed.selectedProjectId).toBeNull()
  })

  test('accepts a user with zero projects (newly created admin)', () => {
    const parsed = meResponseSchema.parse({
      ...validPayload,
      projects: [],
      selectedProjectId: null,
    })
    expect(parsed.projects).toEqual([])
  })

  test('rejects an invalid global user.role', () => {
    expect(() =>
      meResponseSchema.parse({
        ...validPayload,
        user: { ...validPayload.user, roles: ['superuser'] },
      })
    ).toThrow()
  })

  test('per-project membership role string is NOT constrained to the global tier enum', () => {
    // Per-project roles use their own vocabulary (admin|contributor|viewer);
    // the response schema deliberately stays loose so this layer doesn't
    // couple to today's per-project values.
    const parsed = meResponseSchema.parse({
      ...validPayload,
      projects: [{ id: 1, name: 'P1', slug: 'p1', roles: ['contributor'] }],
    })
    expect(parsed.projects[0]?.roles).toEqual(['contributor'])
  })
})
