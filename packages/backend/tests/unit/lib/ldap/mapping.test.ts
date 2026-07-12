/**
 * Unit tests for LDAP identity/role mapping (U3 of the AD/LDAP
 * authentication plan,
 * docs/plans/2026-07-12-001-feat-adldap-authentication-support-plan.md).
 *
 * Pure logic under test:
 *  - resolveRole: highest-privilege group -> global role, fail-closed
 *    to `null` when no configured group matches (R5, R6).
 *  - deriveEmail: reads the single configurable `emailAttribute` from
 *    U1's LdapConfig, falling back to a synthesized `username@realm`
 *    email when that attribute is absent (R10).
 *
 * No Docker, DB, or LDAP connection required.
 */
import { describe, expect, it } from 'bun:test'

import type { LdapGroupRoleMap } from '../../../../src/config/ldap.js'

import { deriveEmail, resolveRole } from '../../../../src/lib/ldap/mapping.js'

const GROUP_ROLE_MAP: LdapGroupRoleMap = {
  admin: ['cn=hh-admins,ou=groups,dc=lab,dc=local'],
  operator: ['cn=hh-operators,ou=groups,dc=lab,dc=local'],
  analyst: ['cn=hh-analysts,ou=groups,dc=lab,dc=local'],
}

describe('resolveRole', () => {
  it('Covers AE1. maps a single mapped group to that role', () => {
    const role = resolveRole(['cn=hh-operators,ou=groups,dc=lab,dc=local'], GROUP_ROLE_MAP)

    expect(role).toBe('operator')
  })

  it('Covers AE3. resolves the highest-privilege role when multiple groups match (admin wins over operator)', () => {
    const role = resolveRole(
      ['cn=hh-operators,ou=groups,dc=lab,dc=local', 'cn=hh-admins,ou=groups,dc=lab,dc=local'],
      GROUP_ROLE_MAP
    )

    expect(role).toBe('admin')
  })

  it('resolves the highest-privilege role when operator and analyst both match (operator wins over analyst)', () => {
    const role = resolveRole(
      ['cn=hh-analysts,ou=groups,dc=lab,dc=local', 'cn=hh-operators,ou=groups,dc=lab,dc=local'],
      GROUP_ROLE_MAP
    )

    expect(role).toBe('operator')
  })

  it('Covers AE2. returns null when the user matches no mapped group', () => {
    const role = resolveRole(['cn=some-other-group,ou=groups,dc=lab,dc=local'], GROUP_ROLE_MAP)

    expect(role).toBeNull()
  })

  it('returns null for an empty groups list (fail-closed)', () => {
    const role = resolveRole([], GROUP_ROLE_MAP)

    expect(role).toBeNull()
  })

  it('returns null when every role list in the map is empty (fail-closed downstream of U1)', () => {
    const role = resolveRole(['cn=hh-admins,ou=groups,dc=lab,dc=local'], {
      admin: [],
      operator: [],
      analyst: [],
    })

    expect(role).toBeNull()
  })

  it('matches group identifiers case-insensitively and ignoring surrounding whitespace', () => {
    const role = resolveRole(['  CN=HH-Admins,OU=Groups,DC=Lab,DC=Local  '], GROUP_ROLE_MAP)

    expect(role).toBe('admin')
  })

  it('matches when the configured list entry has different case/whitespace than the directory value', () => {
    const map: LdapGroupRoleMap = {
      admin: ['  CN=HH-Admins,OU=Groups,DC=Lab,DC=Local  '],
      operator: [],
      analyst: [],
    }

    const role = resolveRole(['cn=hh-admins,ou=groups,dc=lab,dc=local'], map)

    expect(role).toBe('admin')
  })
})

describe('deriveEmail', () => {
  it('uses the configured email attribute verbatim when present', () => {
    const email = deriveEmail({ mail: 'jdoe@corp.example.com' }, 'jdoe', 'lab.local', 'mail')

    expect(email).toBe('jdoe@corp.example.com')
  })

  it('Covers AE5. synthesizes username@realm when the configured email attribute is absent', () => {
    const email = deriveEmail({}, 'jdoe', 'lab.local', 'mail')

    expect(email).toBe('jdoe@lab.local')
  })

  it('synthesizes username@realm when the configured email attribute is an empty string', () => {
    const email = deriveEmail({ mail: '' }, 'jdoe', 'lab.local', 'mail')

    expect(email).toBe('jdoe@lab.local')
  })

  it('synthesizes username@realm when the configured email attribute is whitespace-only', () => {
    const email = deriveEmail({ mail: '   ' }, 'jdoe', 'lab.local', 'mail')

    expect(email).toBe('jdoe@lab.local')
  })

  it('reads whichever attribute name is configured, not a hardcoded "mail"', () => {
    const email = deriveEmail(
      { userPrincipalName: 'jdoe@corp.example.com', mail: '' },
      'jdoe',
      'lab.local',
      'userPrincipalName'
    )

    expect(email).toBe('jdoe@corp.example.com')
  })

  it('code review FIX 4: lowercases a mixed-case directory email attribute so case-only differences from a stored HashHive email still collide (R11)', () => {
    const email = deriveEmail({ mail: 'John.Doe@Corp.Example.COM' }, 'jdoe', 'lab.local', 'mail')

    expect(email).toBe('john.doe@corp.example.com')
  })

  it('code review FIX 4: lowercases the synthesized username@realm fallback', () => {
    const email = deriveEmail({}, 'JDoe', 'Lab.Local', 'mail')

    expect(email).toBe('jdoe@lab.local')
  })
})
