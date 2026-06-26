/**
 * Unit tests for AUDIT_LOG_RETENTION env-var validation (U9 / #105).
 *
 * Verifies that the envSchema rejects malformed interval strings at startup
 * rather than letting them propagate to SQL. No Docker required — uses
 * envSchema.safeParse() directly without executing any DB or Redis calls.
 */

import { describe, expect, it } from 'bun:test'

import { envSchema } from '../../src/config/env.js'

// Minimum valid env so safeParse doesn't fail on unrelated required fields.
const BASE_ENV = {
  DATABASE_URL: 'postgres://localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'test-secret-at-least-32-chars-long!!',
}

describe('AUDIT_LOG_RETENTION env validation', () => {
  it('accepts a valid interval string', () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      AUDIT_LOG_RETENTION: '30 days',
    })
    const hasError = result.error?.issues.some((i) => i.path[0] === 'AUDIT_LOG_RETENTION') ?? false
    expect(hasError).toBe(false)
  })

  it('accepts the default value "365 days"', () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      AUDIT_LOG_RETENTION: '365 days',
    })
    const hasError = result.error?.issues.some((i) => i.path[0] === 'AUDIT_LOG_RETENTION') ?? false
    expect(hasError).toBe(false)
  })

  it('accepts plural units', () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      AUDIT_LOG_RETENTION: '2 hours',
    })
    const hasError = result.error?.issues.some((i) => i.path[0] === 'AUDIT_LOG_RETENTION') ?? false
    expect(hasError).toBe(false)
  })

  it('accepts singular units', () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      AUDIT_LOG_RETENTION: '1 year',
    })
    const hasError = result.error?.issues.some((i) => i.path[0] === 'AUDIT_LOG_RETENTION') ?? false
    expect(hasError).toBe(false)
  })

  it('rejects a plain word with no number', () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      AUDIT_LOG_RETENTION: 'banana',
    })
    const hasError = result.error?.issues.some((i) => i.path[0] === 'AUDIT_LOG_RETENTION') ?? false
    expect(hasError).toBe(true)
  })

  it('rejects an unsupported unit', () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      AUDIT_LOG_RETENTION: '30 fortnights',
    })
    const hasError = result.error?.issues.some((i) => i.path[0] === 'AUDIT_LOG_RETENTION') ?? false
    expect(hasError).toBe(true)
  })

  it('rejects a bare number', () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      AUDIT_LOG_RETENTION: '365',
    })
    const hasError = result.error?.issues.some((i) => i.path[0] === 'AUDIT_LOG_RETENTION') ?? false
    expect(hasError).toBe(true)
  })

  it('rejects an empty string', () => {
    const result = envSchema.safeParse({
      ...BASE_ENV,
      AUDIT_LOG_RETENTION: '',
    })
    const hasError = result.error?.issues.some((i) => i.path[0] === 'AUDIT_LOG_RETENTION') ?? false
    expect(hasError).toBe(true)
  })

  it('uses "365 days" as the default when the field is absent', () => {
    const result = envSchema.safeParse(BASE_ENV)
    // Should not have an AUDIT_LOG_RETENTION error even without setting it.
    const hasError = result.error?.issues.some((i) => i.path[0] === 'AUDIT_LOG_RETENTION') ?? false
    expect(hasError).toBe(false)
    // And the parsed value (if success) should be the default.
    if (result.success) {
      expect(result.data.AUDIT_LOG_RETENTION).toBe('365 days')
    }
  })
})
