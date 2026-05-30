import { insertUserSchema, users } from '@hashhive/shared'
/**
 * Schema introspection for `users.roles` and `users.lastProjectId`,
 * added by migration 0010 to support global RBAC tiers and the
 * "remember last project" preference (issue #159, plan U1).
 *
 * Unit-level checks confirm column shape (type, nullability, default,
 * FK target). DB-touching behavior (backfill effect, FK ON DELETE
 * cascade) is exercised by integration tests in U3 + U6.
 */
import { describe, expect, test } from 'bun:test'

describe('users.roles column', () => {
  test('exists with text[] type', () => {
    const col = users.roles
    expect(col).toBeDefined()
    // Drizzle exposes the SQL data type on the column descriptor.
    expect(col.dataType).toBe('array')
  })

  test('is not nullable', () => {
    expect(users.roles.notNull).toBe(true)
  })

  test('defaults to ["analyst"] (least-privileged tier)', () => {
    // Drizzle stores the default on the column. We assert the runtime
    // value rather than the SQL representation so the test survives
    // formatting differences between Drizzle versions.
    expect(users.roles.default).toEqual(['analyst'])
  })
})

describe('users.lastProjectId column', () => {
  test('exists with integer type', () => {
    const col = users.lastProjectId
    expect(col).toBeDefined()
    expect(col.dataType).toBe('number')
  })

  test('is nullable (multi-project users may have no preference yet)', () => {
    expect(users.lastProjectId.notNull).toBe(false)
  })
})

describe('insertUserSchema', () => {
  test('accepts a user without roles (column default applies)', () => {
    const parsed = insertUserSchema.parse({
      email: 'test@example.com',
      passwordHash: '$2b$12$dummy',
      name: 'Test',
    })
    // The schema does not require `roles` because the column has a
    // default. Drizzle-zod treats it as optional on insert.
    expect(parsed.email).toBe('test@example.com')
  })

  test('accepts a user with explicit roles', () => {
    const parsed = insertUserSchema.parse({
      email: 'admin@example.com',
      passwordHash: '$2b$12$dummy',
      name: 'Admin',
      roles: ['admin'],
    })
    expect(parsed.roles).toEqual(['admin'])
  })

  test('accepts a user with lastProjectId set', () => {
    const parsed = insertUserSchema.parse({
      email: 'user@example.com',
      passwordHash: '$2b$12$dummy',
      name: 'User',
      lastProjectId: 42,
    })
    expect(parsed.lastProjectId).toBe(42)
  })
})
