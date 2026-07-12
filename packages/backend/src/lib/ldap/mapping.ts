import type { UserRole } from '@hashhive/shared'

import type { LdapGroupRoleMap } from '../../config/ldap.js'

/**
 * Highest-to-lowest privilege order (R6). `resolveRole` walks this list
 * and returns the first role whose configured group list intersects the
 * user's directory groups, so a user in both `hh-admins` and
 * `hh-operators` resolves to `admin`.
 */
const ROLE_PRECEDENCE: readonly UserRole[] = ['admin', 'operator', 'analyst']

/**
 * Normalizes a directory group identifier (DN or CN, per
 * `LDAP_GROUP_STRATEGY`) for comparison: trims surrounding whitespace and
 * lowercases. Directory servers are case-insensitive on DN components,
 * and operators may not match the exact case the directory returns when
 * they fill in `LDAP_GROUP_*`, so comparisons must not depend on case or
 * incidental whitespace.
 */
function normalizeGroupIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase()
}

/**
 * Maps a user's directory group membership to the highest-privilege
 * HashHive global role, fail-closed (R5, R6). Returns `null` when the
 * user's groups intersect none of the configured role lists -- callers
 * MUST treat `null` as "deny access", never as a default role. An empty
 * `groups` array (no membership resolved) always yields `null`.
 */
export function resolveRole(
  groups: readonly string[],
  groupRoleMap: LdapGroupRoleMap
): UserRole | null {
  const normalizedGroups = new Set(groups.map(normalizeGroupIdentifier))

  for (const role of ROLE_PRECEDENCE) {
    const mappedGroups = groupRoleMap[role]
    const isMatch = mappedGroups.some((mappedGroup) =>
      normalizedGroups.has(normalizeGroupIdentifier(mappedGroup))
    )

    if (isMatch) {
      return role
    }
  }

  return null
}

/**
 * Derives the HashHive account email for a directory user (R10). Reads
 * the single configurable `emailAttribute` (from U1's `LdapConfig`,
 * default `mail`) off the directory entry's attributes; when that
 * attribute is absent, empty, or whitespace-only, synthesizes a stable
 * email as `username@realm` instead. Deployments that expose email as
 * `userPrincipalName` rather than `mail` point `LDAP_EMAIL_ATTRIBUTE`
 * there -- this function never hardcodes a `mail`/`userPrincipalName`
 * pair.
 */
export function deriveEmail(
  attributes: Readonly<Record<string, string>>,
  username: string,
  realm: string,
  emailAttribute: string
): string {
  const rawEmail = attributes[emailAttribute]
  const trimmedEmail = rawEmail?.trim()

  if (trimmedEmail) {
    return trimmedEmail
  }

  return `${username}@${realm}`
}
