/**
 * Local narrow types for the LDAP directory client (U2).
 *
 * These describe the client's own request/response shapes, not a wire
 * contract that crosses an HTTP API boundary -- per AGENTS.md's
 * shared-shapes rule, only cross-boundary shapes belong in
 * `@hashhive/shared`. `DirectoryAuthResult` is consumed directly by U5's
 * BetterAuth plugin within the backend process; it is never serialized to a
 * client.
 */

/**
 * Directory attribute values, normalized to single strings. Multi-valued
 * attributes (other than group membership, which travels separately as
 * `groups`) collapse to their first value -- callers only ever read a
 * single configurable email attribute (R10) off this map, so a second or
 * third value is never needed.
 */
export type DirectoryAttributes = Readonly<Record<string, string>>

/** A successful search-then-bind: the user's password verified against their directory entry. */
export interface DirectoryAuthSuccess {
  ok: true
  /** The user entry's distinguished name, as resolved by the service-account search. */
  dn: string
  attributes: DirectoryAttributes
  /**
   * Full group DNs the user belongs to, resolved per the configured
   * `LDAP_GROUP_STRATEGY` (either the user entry's `memberOf` attribute, or
   * a group-base search for entries whose `member` lists this user's DN).
   */
  groups: readonly string[]
}

/**
 * `invalid_credentials` covers a wrong password AND an unknown username --
 * deliberately the same reason and shape for both, so a caller (and an
 * attacker probing the endpoint) cannot distinguish "no such user" from
 * "wrong password" (R22, no user-enumeration).
 *
 * `unavailable` covers everything else that prevents a definitive answer:
 * the directory server is unreachable, times out, or the service account's
 * own bind fails (a deployment misconfiguration, not the end user's fault).
 */
export type DirectoryAuthFailureReason = 'invalid_credentials' | 'unavailable'

export interface DirectoryAuthFailure {
  ok: false
  reason: DirectoryAuthFailureReason
}

export type DirectoryAuthResult = DirectoryAuthSuccess | DirectoryAuthFailure
