/**
 * Unit tests for LDAP configuration (U1 of the AD/LDAP authentication plan,
 * docs/plans/2026-07-12-001-feat-adldap-authentication-support-plan.md).
 *
 * Two things under test:
 *  - envSchema's LDAP_* fields and the superRefine that makes them
 *    conditionally required (fail-fast) only when LDAP_ENABLED is true,
 *    mirroring the existing AUDIT_LOG_RETENTION env-validation pattern in
 *    tests/unit/audit-retention-env.test.ts.
 *  - config/ldap.ts's pure group-list parser and typed `getLdapConfig`
 *    accessor, which is `null` when directory auth is disabled.
 *
 * No Docker required — uses envSchema.safeParse()/parse() directly without
 * executing any DB, Redis, or LDAP calls.
 */
import { describe, expect, it } from 'bun:test'

import { envSchema } from '../../../src/config/env.js'
import { buildGroupRoleMap, getLdapConfig, parseGroupList } from '../../../src/config/ldap.js'

// Minimum valid env so safeParse doesn't fail on unrelated required fields.
const BASE_ENV = {
  DATABASE_URL: 'postgres://localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY: 'test-access-key',
  S3_SECRET_KEY: 'test-secret-key',
  BETTER_AUTH_SECRET: 'test-secret-at-least-32-chars-long!!',
}

// A minimal env that satisfies every field envSchema requires when
// LDAP_ENABLED is true and LDAP_TLS is left at its default ('ldaps',
// which does not need the insecure-transport opt-in).
const ENABLED_LDAP_ENV = {
  ...BASE_ENV,
  LDAP_ENABLED: 'true',
  LDAP_URL: 'ldaps://ldap.lab.local:636',
  LDAP_BIND_DN: 'cn=svc-hashhive,dc=lab,dc=local',
  LDAP_BIND_PASSWORD: 'svc-password',
  LDAP_SEARCH_BASE: 'ou=people,dc=lab,dc=local',
  LDAP_USER_FILTER: '(uid=%s)',
  LDAP_REALM: 'lab.local',
}

function fieldHasError(result: ReturnType<typeof envSchema.safeParse>, field: string): boolean {
  return result.error?.issues.some((issue) => issue.path[0] === field) ?? false
}

describe('envSchema LDAP_* validation', () => {
  it('parses with LDAP_ENABLED unset and no other LDAP vars set (existing deploy unaffected)', () => {
    const result = envSchema.safeParse(BASE_ENV)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.LDAP_ENABLED).toBe(false)
      expect(result.data.LDAP_TLS).toBe('ldaps')
      expect(result.data.LDAP_GROUP_STRATEGY).toBe('memberOf')
      expect(result.data.LDAP_EMAIL_ATTRIBUTE).toBe('mail')
    }
  })

  it('parses with LDAP_ENABLED explicitly "false" and no other LDAP vars set', () => {
    const result = envSchema.safeParse({ ...BASE_ENV, LDAP_ENABLED: 'false' })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.LDAP_ENABLED).toBe(false)
    }
  })

  it('throws a clear error when LDAP_ENABLED is true but LDAP_URL is missing', () => {
    const { LDAP_URL: _omit, ...withoutUrl } = ENABLED_LDAP_ENV
    const result = envSchema.safeParse(withoutUrl)

    expect(result.success).toBe(false)
    expect(fieldHasError(result, 'LDAP_URL')).toBe(true)
  })

  it('accepts a fully-configured LDAP_ENABLED=true env with defaults for TLS and group strategy', () => {
    const result = envSchema.safeParse(ENABLED_LDAP_ENV)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.LDAP_ENABLED).toBe(true)
      expect(result.data.LDAP_URL).toBe(ENABLED_LDAP_ENV.LDAP_URL)
    }
  })

  it('rejects LDAP_GROUP_STRATEGY=search without LDAP_GROUP_BASE', () => {
    const result = envSchema.safeParse({
      ...ENABLED_LDAP_ENV,
      LDAP_GROUP_STRATEGY: 'search',
    })

    expect(result.success).toBe(false)
    expect(fieldHasError(result, 'LDAP_GROUP_BASE')).toBe(true)
  })

  it('accepts LDAP_GROUP_STRATEGY=search when LDAP_GROUP_BASE is set', () => {
    const result = envSchema.safeParse({
      ...ENABLED_LDAP_ENV,
      LDAP_GROUP_STRATEGY: 'search',
      LDAP_GROUP_BASE: 'ou=groups,dc=lab,dc=local',
    })

    expect(result.success).toBe(true)
  })

  it('rejects LDAP_TLS=none without LDAP_ALLOW_INSECURE_TRANSPORT=true', () => {
    const result = envSchema.safeParse({
      ...ENABLED_LDAP_ENV,
      LDAP_TLS: 'none',
    })

    expect(result.success).toBe(false)
    expect(fieldHasError(result, 'LDAP_ALLOW_INSECURE_TRANSPORT')).toBe(true)
  })

  it('rejects LDAP_TLS=none with LDAP_ALLOW_INSECURE_TRANSPORT explicitly "false"', () => {
    const result = envSchema.safeParse({
      ...ENABLED_LDAP_ENV,
      LDAP_TLS: 'none',
      LDAP_ALLOW_INSECURE_TRANSPORT: 'false',
    })

    expect(result.success).toBe(false)
    expect(fieldHasError(result, 'LDAP_ALLOW_INSECURE_TRANSPORT')).toBe(true)
  })

  it('accepts LDAP_TLS=none when LDAP_ALLOW_INSECURE_TRANSPORT=true', () => {
    const result = envSchema.safeParse({
      ...ENABLED_LDAP_ENV,
      LDAP_TLS: 'none',
      LDAP_ALLOW_INSECURE_TRANSPORT: 'true',
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.LDAP_ALLOW_INSECURE_TRANSPORT).toBe(true)
    }
  })

  it('rejects LDAP_ENABLED=true with a whitespace-only LDAP_BIND_PASSWORD', () => {
    const result = envSchema.safeParse({
      ...ENABLED_LDAP_ENV,
      LDAP_BIND_PASSWORD: '   ',
    })

    expect(result.success).toBe(false)
    expect(fieldHasError(result, 'LDAP_BIND_PASSWORD')).toBe(true)
  })
})

describe('parseGroupList', () => {
  it('splits and trims a comma-separated list', () => {
    expect(parseGroupList('cn=admins, cn=ops , cn=leads')).toEqual([
      'cn=admins',
      'cn=ops',
      'cn=leads',
    ])
  })

  it('drops empty entries from stray commas and whitespace', () => {
    expect(parseGroupList(' a, ,b,, c ,')).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty array for an empty string', () => {
    expect(parseGroupList('')).toEqual([])
  })

  it('returns an empty array for a whitespace-only string', () => {
    expect(parseGroupList('   ')).toEqual([])
  })
})

describe('buildGroupRoleMap', () => {
  it('parses each of the three group env vars into its own role list', () => {
    const map = buildGroupRoleMap({
      LDAP_GROUP_ADMIN: 'cn=hh-admins',
      LDAP_GROUP_OPERATOR: 'cn=hh-operators, cn=hh-leads',
      LDAP_GROUP_ANALYST: '',
    })

    expect(map).toEqual({
      admin: ['cn=hh-admins'],
      operator: ['cn=hh-operators', 'cn=hh-leads'],
      analyst: [],
    })
  })

  it('yields empty lists for all roles when every group var is empty (fail-closed downstream)', () => {
    const map = buildGroupRoleMap({
      LDAP_GROUP_ADMIN: '',
      LDAP_GROUP_OPERATOR: '',
      LDAP_GROUP_ANALYST: '',
    })

    expect(map).toEqual({ admin: [], operator: [], analyst: [] })
  })
})

describe('getLdapConfig', () => {
  it('returns null when LDAP_ENABLED is false', () => {
    const parsed = envSchema.parse(BASE_ENV)

    expect(getLdapConfig(parsed)).toBeNull()
  })

  it('returns a typed config object when LDAP_ENABLED is true', () => {
    const parsed = envSchema.parse({
      ...ENABLED_LDAP_ENV,
      LDAP_GROUP_ADMIN: 'cn=hh-admins',
      LDAP_GROUP_OPERATOR: 'cn=hh-operators',
      LDAP_GROUP_ANALYST: 'cn=hh-analysts',
    })

    const config = getLdapConfig(parsed)

    expect(config).not.toBeNull()
    expect(config?.url).toBe(ENABLED_LDAP_ENV.LDAP_URL)
    expect(config?.tls).toBe('ldaps')
    expect(config?.bindDn).toBe(ENABLED_LDAP_ENV.LDAP_BIND_DN)
    expect(config?.bindPassword).toBe(ENABLED_LDAP_ENV.LDAP_BIND_PASSWORD)
    expect(config?.searchBase).toBe(ENABLED_LDAP_ENV.LDAP_SEARCH_BASE)
    expect(config?.userFilter).toBe(ENABLED_LDAP_ENV.LDAP_USER_FILTER)
    expect(config?.groupStrategy).toBe('memberOf')
    expect(config?.emailAttribute).toBe('mail')
    expect(config?.realm).toBe('lab.local')
    expect(config?.allowInsecureTransport).toBe(false)
    expect(config?.groupRoleMap).toEqual({
      admin: ['cn=hh-admins'],
      operator: ['cn=hh-operators'],
      analyst: ['cn=hh-analysts'],
    })
  })
})
