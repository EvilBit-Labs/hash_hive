import type { UserRole } from '@hashhive/shared'

import { readFileSync } from 'node:fs'

import type { Env } from './env.js'

/**
 * Group-to-role map (KTD4): one directory group-identifier list (DN or CN,
 * depending on `LDAP_GROUP_STRATEGY`) per HashHive global capability tier.
 * Keyed by `Record<UserRole, string[]>` rather than a hand-declared
 * `{ admin; operator; analyst }` shape, so adding a role tier to
 * `UserRole` (`@hashhive/shared`) forces this map (and every place that
 * builds one, e.g. `buildGroupRoleMap`) to be updated too, instead of
 * silently drifting out of sync with the role vocabulary. An empty list
 * for a role means "no group is mapped to that role" — nobody can ever
 * match it, which is the fail-closed default (R5, R6).
 */
export type LdapGroupRoleMap = Record<UserRole, string[]>

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
  /**
   * The CA certificate's PEM content, already resolved by `resolveCaCert`
   * at config-build time (below) -- never a raw `LDAP_TLS_CA_CERT` value
   * that still needs a filesystem read. This keeps every per-login TLS
   * connection (U2's `createClient` / `maybeStartTls`, called 2-3x per
   * sign-in attempt) free of a synchronous disk read in the request hot
   * path; the read happens exactly once, here, when the process starts.
   */
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

/**
 * Resolves a configured CA certificate to its PEM content: either an
 * inline PEM block (returned verbatim) or a filesystem path (read once,
 * here). Called exactly once per process, from `getLdapConfig` below, so
 * `LdapConfig.tlsCaCert` always carries already-resolved content rather
 * than a path a per-login TLS connection would otherwise re-read via
 * `readFileSync` on every `createClient`/`maybeStartTls` call (U2's
 * `client.ts`, 2-3 reads per sign-in attempt).
 */
export function resolveCaCert(caCert: string | undefined): string | undefined {
  if (!caCert) {
    return undefined
  }
  if (caCert.includes('BEGIN CERTIFICATE')) {
    return caCert
  }
  return readFileSync(caCert, 'utf8')
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
    tlsCaCert: resolveCaCert(env.LDAP_TLS_CA_CERT),
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
