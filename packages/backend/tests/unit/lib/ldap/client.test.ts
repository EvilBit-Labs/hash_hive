/**
 * Unit tests for LDAP filter-value escaping (U2 of the AD/LDAP
 * authentication plan,
 * docs/plans/2026-07-12-001-feat-adldap-authentication-support-plan.md).
 *
 * Pure logic under test:
 *  - escapeLdapFilterValue: RFC 4515 filter-value escaping.
 *  - buildUserFilter: templates the escaped username into LDAP_USER_FILTER.
 *
 * Regression coverage for a P1 bug where space was incorrectly escaped to
 * `\00` (the NUL escape, not a space escape), corrupting any filter value
 * containing a space -- e.g. a DN (`cn=John Doe,...`) under the `search`
 * group strategy, or a spaced username -- and denying legitimate users.
 *
 * No Docker, DB, or LDAP connection required.
 */
import { describe, expect, it } from 'bun:test'

import { buildUserFilter, escapeLdapFilterValue } from '../../../../src/lib/ldap/client.js'

describe('escapeLdapFilterValue', () => {
  it('emits a space literally rather than escaping it to \\00', () => {
    expect(escapeLdapFilterValue('John Doe')).toBe('John Doe')
  })

  it('emits a DN containing spaces literally', () => {
    expect(escapeLdapFilterValue('cn=John Doe,ou=Users,dc=lab,dc=local')).toBe(
      'cn=John Doe,ou=Users,dc=lab,dc=local'
    )
  })

  it('still escapes RFC 4515 special characters (* ( ) \\)', () => {
    expect(escapeLdapFilterValue('*')).toBe('\\2a')
    expect(escapeLdapFilterValue('(')).toBe('\\28')
    expect(escapeLdapFilterValue(')')).toBe('\\29')
    expect(escapeLdapFilterValue('\\')).toBe('\\5c')
  })

  it('escapes backslash before the characters it introduces are re-escaped', () => {
    expect(escapeLdapFilterValue('a\\b')).toBe('a\\5cb')
  })

  it('escapes a mixed value with special characters and a space', () => {
    expect(escapeLdapFilterValue('John (Admin) *Doe*')).toBe('John \\28Admin\\29 \\2aDoe\\2a')
  })
})

describe('buildUserFilter', () => {
  it('templates a spaced username literally, not NUL-escaped', () => {
    const filter = buildUserFilter('(sAMAccountName=%s)', 'John Doe')

    expect(filter).toBe('(sAMAccountName=John Doe)')
  })

  it('escapes filter-injection characters in the username', () => {
    const filter = buildUserFilter('(uid=%s)', '*)(uid=*')

    expect(filter).toBe('(uid=\\2a\\29\\28uid=\\2a)')
  })

  it('throws when the template has no %s placeholder', () => {
    expect(() => buildUserFilter('(uid=admin)', 'jdoe')).toThrow(
      /does not contain the %s username placeholder/
    )
  })
})
