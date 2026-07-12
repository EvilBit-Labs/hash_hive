import type { Env } from './env.js'

/**
 * Group-to-role map (KTD4): three discrete lists of directory group
 * identifiers (DN or CN, depending on `LDAP_GROUP_STRATEGY`), one per
 * HashHive global capability tier. An empty list for a role means "no
 * group is mapped to that role" — nobody can ever match it, which is the
 * fail-closed default (R5, R6).
 */
export interface LdapGroupRoleMap {
  admin: string[]
  operator: string[]
  analyst: string[]
}

/**
 * Typed LDAP configuration surface, produced only when directory auth is
 * enabled. Consumers (U2 client, U3 mapping, U4 provisioning, U5 plugin)
 * take this shape rather than reading `env.LDAP_*` directly, so the
 * "required when enabled" narrowing happens once, here.
 *
 * `emailAttribute` is intentionally a single configurable attribute name
 * (default `mail`) rather than a hardcoded mail/userPrincipalName pair —
 * U3's `deriveEmail` reads `attributes[config.emailAttribute]` and falls
 * back to a synthesized `username@realm` email when that attribute is
 * absent on the directory entry (R10). Deployments that expose email as
 * `userPrincipalName` instead of `mail` (common on some AD setups) point
 * `LDAP_EMAIL_ATTRIBUTE` there rather than requiring a code change.
 */
export interface LdapConfig {
  url: string
  tls: 'ldaps' | 'starttls' | 'none'
  tlsCaCert: string | undefined
  allowInsecureTransport: boolean
  bindDn: string
  bindPassword: string
  searchBase: string
  userFilter: string
  groupStrategy: 'memberOf' | 'search'
  groupBase: string | undefined
  groupRoleMap: LdapGroupRoleMap
  emailAttribute: string
  realm: string
}

/**
 * Splits a comma-separated group-identifier list into a trimmed,
 * non-empty array. An unset or whitespace-only var yields an empty
 * array — callers must treat "no groups configured for this role" as
 * "no user can ever match this role" (fail-closed), never as "match
 * everyone".
 */
export function parseGroupList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

type GroupRoleEnv = Pick<Env, 'LDAP_GROUP_ADMIN' | 'LDAP_GROUP_OPERATOR' | 'LDAP_GROUP_ANALYST'>

/**
 * Parses the three discrete `LDAP_GROUP_*` env vars (KTD4) into the
 * `{ admin, operator, analyst }` list map that `resolveRole` (U3)
 * consumes.
 */
export function buildGroupRoleMap(env: GroupRoleEnv): LdapGroupRoleMap {
  return {
    admin: parseGroupList(env.LDAP_GROUP_ADMIN),
    operator: parseGroupList(env.LDAP_GROUP_OPERATOR),
    analyst: parseGroupList(env.LDAP_GROUP_ANALYST),
  }
}

/**
 * Typed accessor for the LDAP configuration surface. Returns `null` when
 * directory auth is disabled (`LDAP_ENABLED=false`, the default) so
 * callers can branch once — construct the client/plugin only when
 * enabled — rather than threading an `enabled` flag through every LDAP
 * call site.
 *
 * When `LDAP_ENABLED` is true, `envSchema`'s `superRefine` has already
 * guaranteed `LDAP_URL`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`,
 * `LDAP_SEARCH_BASE`, `LDAP_USER_FILTER`, `LDAP_REALM` (and
 * `LDAP_GROUP_BASE` when the strategy is `search`) are non-empty strings.
 * The check below only narrows those optional types for the compiler; it
 * intentionally throws rather than silently reading `undefined` if that
 * invariant is ever violated (e.g. this accessor is called against a
 * hand-built object that skipped `envSchema.parse`).
 */
export function getLdapConfig(env: Env): LdapConfig | null {
  if (!env.LDAP_ENABLED) {
    return null
  }

  const {
    LDAP_URL,
    LDAP_BIND_DN,
    LDAP_BIND_PASSWORD,
    LDAP_SEARCH_BASE,
    LDAP_USER_FILTER,
    LDAP_REALM,
  } = env

  if (
    !LDAP_URL ||
    !LDAP_BIND_DN ||
    !LDAP_BIND_PASSWORD ||
    !LDAP_SEARCH_BASE ||
    !LDAP_USER_FILTER ||
    !LDAP_REALM
  ) {
    throw new Error(
      'LDAP_ENABLED is true but a required LDAP_* variable is missing. This should have been caught by envSchema validation at startup.'
    )
  }

  if (env.LDAP_GROUP_STRATEGY === 'search' && !env.LDAP_GROUP_BASE) {
    throw new Error(
      'LDAP_ENABLED is true and LDAP_GROUP_STRATEGY is "search" but LDAP_GROUP_BASE is missing. This should have been caught by envSchema validation at startup.'
    )
  }

  return {
    url: LDAP_URL,
    tls: env.LDAP_TLS,
    tlsCaCert: env.LDAP_TLS_CA_CERT,
    allowInsecureTransport: env.LDAP_ALLOW_INSECURE_TRANSPORT,
    bindDn: LDAP_BIND_DN,
    bindPassword: LDAP_BIND_PASSWORD,
    searchBase: LDAP_SEARCH_BASE,
    userFilter: LDAP_USER_FILTER,
    groupStrategy: env.LDAP_GROUP_STRATEGY,
    groupBase: env.LDAP_GROUP_BASE,
    groupRoleMap: buildGroupRoleMap(env),
    emailAttribute: env.LDAP_EMAIL_ATTRIBUTE,
    realm: LDAP_REALM,
  }
}
