/**
 * LDAP directory client: search-then-bind (U2 of the AD/LDAP authentication
 * plan, docs/plans/2026-07-12-001-feat-adldap-authentication-support-plan.md).
 *
 * `authenticateDirectory(username, password, config)` is the single entry
 * point (R2, R3, R4). It:
 *
 *   1. Rejects an empty/whitespace password before making any LDAP call --
 *      RFC 4513 5.1.2 makes a bind with a DN and a zero-length password an
 *      "unauthenticated bind", which many servers accept as SUCCESS
 *      regardless of whether the password is correct. Letting an empty
 *      password reach the verification bind would be a full auth bypass.
 *   2. Opens a connection to the directory (honoring `LDAP_TLS`: `ldaps`,
 *      `starttls`, or `none`, with an optional custom CA certificate) and
 *      binds as the read-only service account (`LDAP_BIND_DN`).
 *   3. Searches `LDAP_SEARCH_BASE` with `LDAP_USER_FILTER` templated on the
 *      submitted username (the `%s` token), with the username safely
 *      RFC 4515-escaped so it cannot inject filter syntax.
 *   4. Opens a second connection and binds as the found DN with the
 *      submitted password to verify it (the "then-bind" half).
 *   5. Only after that verification bind succeeds, reads group membership
 *      per `LDAP_GROUP_STRATEGY`: `memberOf` reads the attribute off the
 *      user entry (typical AD); `search` queries `LDAP_GROUP_BASE` for
 *      entries whose `member` attribute lists the user's DN (typical
 *      OpenLDAP).
 *
 * When the search finds no matching entry, step 4 still runs -- against a
 * syntactically valid but virtually certain-to-be-absent placeholder DN
 * under the search base -- so an unknown username takes the same code path
 * (one search plus one failed bind) as a wrong password against a real
 * entry (also one search plus one failed bind), and group resolution never
 * runs on either denied path. Deferring group resolution until after a
 * successful verification bind keeps both denial paths symmetric (R22, no
 * user-enumeration side channel via response timing) and avoids a wasted
 * group-membership search on every failed login.
 *
 * Error mapping: any `ResultCodeError` (a real LDAP protocol response --
 * invalid credentials, no such object, etc.) from the *verification* bind
 * (step 5) becomes `invalid_credentials`. Every other failure -- the
 * service-account bind, the search, TLS negotiation, or a connection-level
 * error (refused, timed out) -- becomes `unavailable`, since it reflects a
 * directory or deployment problem rather than the submitted credentials.
 *
 * Never logs the submitted password or the bind secret: log statements in
 * this module carry only the error's `name`/`message`, never `password`,
 * `config.bindPassword`, or any LDAP client/options object that might embed
 * them.
 */

import type * as tls from 'node:tls'

import { Client, type ClientOptions, DN, type Entry, ResultCodeError } from 'ldapts'

import type { LdapConfig } from '../../config/ldap.js'
import type { DirectoryAttributes, DirectoryAuthResult } from './types.js'

import { logger } from '../../config/logger.js'

// ─── Constants ──────────────────────────────────────────────────────────────

/** Milliseconds to wait for the initial TCP connection before giving up. */
const CONNECT_TIMEOUT_MS = 5_000
/** Milliseconds to wait for an individual LDAP operation (bind/search) to complete. */
const OPERATION_TIMEOUT_MS = 10_000
/** Placeholder token in `LDAP_USER_FILTER` substituted with the escaped username. */
const USERNAME_TOKEN = '%s'
/** memberOf is a backlink attribute AD does not return with `*`; it must be requested explicitly. */
const MEMBER_OF_ATTRIBUTE = 'memberOf'

// ─── Filter / DN escaping ───────────────────────────────────────────────────

/**
 * RFC 4515 filter-value escaping. Order matters: backslash is escaped
 * first, so the backslashes this function introduces for `*`, `(`, and `)`
 * are never themselves re-escaped. Space is intentionally NOT escaped --
 * RFC 4515 does not require it, and escaping it (e.g. to `\00`, which is
 * the NUL escape, not a space escape) would corrupt any filter value that
 * legitimately contains a space, such as a DN (`cn=John Doe,...`) under the
 * `search` group strategy or a spaced username.
 */
export function escapeLdapFilterValue(value: string): string {
  let escaped = ''
  for (const char of value) {
    switch (char) {
      case '\\':
        escaped += '\\5c'
        break
      case '*':
        escaped += '\\2a'
        break
      case '(':
        escaped += '\\28'
        break
      case ')':
        escaped += '\\29'
        break
      default:
        escaped += char
    }
  }
  return escaped
}

/**
 * Templates the safely-escaped username into `LDAP_USER_FILTER` (e.g.
 * `(uid=%s)` or `(sAMAccountName=%s)`). Throws if the configured filter has
 * no `%s` placeholder -- a filter that never restricts by username would
 * match every entry under the search base, which is a deployment
 * misconfiguration worth failing loudly on rather than silently ignoring.
 */
export function buildUserFilter(template: string, username: string): string {
  if (!template.includes(USERNAME_TOKEN)) {
    throw new Error(
      `LDAP_USER_FILTER ("${template}") does not contain the ${USERNAME_TOKEN} username placeholder`
    )
  }
  return template.split(USERNAME_TOKEN).join(escapeLdapFilterValue(username))
}

/**
 * Builds a syntactically valid DN under the search base for a username that
 * the directory search found no entry for. Used only to equalize the
 * unknown-username path with the wrong-password path (see module doc) --
 * it does not need to (and almost certainly will not) resolve to a real
 * entry. Escaping is delegated to ldapts's own `DN`/`RDN` implementation
 * (RFC 4514) rather than hand-rolled.
 */
function buildPlaceholderDn(username: string, config: LdapConfig): string {
  const escapedRdn = new DN({ cn: username }).toString()
  return `${escapedRdn},${config.searchBase}`
}

// ─── TLS ────────────────────────────────────────────────────────────────────

/**
 * `config.tlsCaCert` is already-resolved PEM content -- `config/ldap.ts`'s
 * `getLdapConfig` reads it (inline PEM vs filesystem path) exactly once at
 * config-build time via `resolveCaCert`, not here. This function used to
 * do that resolution itself (including a `readFileSync`) on every call,
 * which meant a synchronous disk read on every `createClient`/
 * `maybeStartTls` invocation -- 2-3 per sign-in attempt, in the request
 * hot path.
 */
function buildTlsConnectionOptions(config: LdapConfig): tls.ConnectionOptions {
  return config.tlsCaCert ? { ca: config.tlsCaCert } : {}
}

function createClient(config: LdapConfig): Client {
  const options: ClientOptions = {
    url: config.url,
    connectTimeout: CONNECT_TIMEOUT_MS,
    timeout: OPERATION_TIMEOUT_MS,
  }
  if (config.tls === 'ldaps') {
    options.tlsOptions = buildTlsConnectionOptions(config)
  }
  return new Client(options)
}

/** Upgrades a plain connection to TLS when `LDAP_TLS=starttls`. A no-op for `ldaps` (secure at connect) and `none`. */
async function maybeStartTls(client: Client, config: LdapConfig): Promise<void> {
  if (config.tls === 'starttls') {
    await client.startTLS(buildTlsConnectionOptions(config))
  }
}

// ─── Entry attribute helpers ────────────────────────────────────────────────

function toStringValue(value: Buffer | string): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value
}

/** Reads a multi-valued attribute (e.g. `memberOf`) off a search entry as a string array. */
function getMultiValue(entry: Entry, attributeName: string): string[] {
  const raw = entry[attributeName]
  if (raw === undefined) {
    return []
  }
  const values = Array.isArray(raw) ? raw : [raw]
  return values.map(toStringValue)
}

/** Normalizes a search entry's attributes to single string values (first value wins for multi-valued attributes). */
function normalizeAttributes(entry: Entry): DirectoryAttributes {
  const attributes: Record<string, string> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'dn') {
      continue
    }
    const [first] = Array.isArray(value) ? value : [value]
    if (first === undefined) {
      continue
    }
    attributes[key] = toStringValue(first)
  }
  return attributes
}

// ─── Search-then-bind steps ─────────────────────────────────────────────────

/** Requests every user attribute plus `memberOf` (not returned by `*` on AD) and the configured email attribute explicitly. */
function buildRequestedAttributes(config: LdapConfig): string[] {
  return [...new Set(['*', MEMBER_OF_ATTRIBUTE, config.emailAttribute])]
}

async function findUserEntry(
  client: Client,
  username: string,
  config: LdapConfig
): Promise<Entry | null> {
  const filter = buildUserFilter(config.userFilter, username)
  const { searchEntries } = await client.search(config.searchBase, {
    scope: 'sub',
    filter,
    attributes: buildRequestedAttributes(config),
    sizeLimit: 1,
  })
  return searchEntries[0] ?? null
}

/**
 * Resolves the user's group membership per `LDAP_GROUP_STRATEGY`. Both
 * strategies return full group DNs, matching the DN-or-CN identifiers
 * configured in `LDAP_GROUP_ADMIN`/`LDAP_GROUP_OPERATOR`/`LDAP_GROUP_ANALYST`
 * (U3's `resolveRole` normalizes case/whitespace on comparison).
 */
async function resolveGroups(client: Client, entry: Entry, config: LdapConfig): Promise<string[]> {
  if (config.groupStrategy === 'memberOf') {
    return getMultiValue(entry, MEMBER_OF_ATTRIBUTE)
  }

  const groupBase = config.groupBase
  if (!groupBase) {
    // Guarded by envSchema's superRefine + config/ldap.ts's getLdapConfig
    // (U1) at startup; this should be unreachable in practice.
    throw new Error('LDAP_GROUP_STRATEGY is "search" but LDAP_GROUP_BASE is not configured')
  }

  const filter = `(member=${escapeLdapFilterValue(entry.dn)})`
  const { searchEntries } = await client.search(groupBase, {
    scope: 'sub',
    filter,
    attributes: ['dn'],
  })

  return searchEntries.map((groupEntry) => groupEntry.dn)
}

/**
 * Binds as `dn` with `password` on a fresh connection to verify it. Returns
 * `'invalid'` (never throws) for any `ResultCodeError` -- a real LDAP
 * protocol rejection (invalid credentials, no such object, inappropriate
 * auth, ...) -- since that is a definitive "this password does not verify
 * this DN" answer from a reachable server. Any other error (connection
 * refused, timeout, TLS failure) propagates to the caller, which maps it to
 * `unavailable`.
 */
async function verifyPassword(
  config: LdapConfig,
  dn: string,
  password: string
): Promise<'invalid' | 'ok'> {
  const client = createClient(config)
  try {
    await maybeStartTls(client, config)
    await client.bind(dn, password)
    return 'ok'
  } catch (err) {
    if (err instanceof ResultCodeError) {
      return 'invalid'
    }
    throw err
  } finally {
    await client.unbind().catch(() => {})
  }
}

function hasNonEmptyPassword(password: string): boolean {
  return password.trim().length > 0
}

/** Narrow, credential-free error summary safe to pass to the logger. */
function describeError(err: unknown): { message: string; name: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message }
  }
  return { name: 'UnknownError', message: String(err) }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Verifies a directory username/password via search-then-bind and returns a
 * typed outcome (R2, R3, R4). See the module doc for the full step-by-step
 * behavior and error-mapping rules. Never logs `password` or
 * `config.bindPassword`.
 */
export async function authenticateDirectory(
  username: string,
  password: string,
  config: LdapConfig
): Promise<DirectoryAuthResult> {
  if (!hasNonEmptyPassword(password)) {
    return { ok: false, reason: 'invalid_credentials' }
  }

  const serviceClient = createClient(config)

  try {
    await maybeStartTls(serviceClient, config)
    await serviceClient.bind(config.bindDn, config.bindPassword)

    const entry = await findUserEntry(serviceClient, username, config)

    if (!entry) {
      // Equalize the unknown-username path with the wrong-password path --
      // see module doc. The result is discarded; either way this branch
      // always denies.
      await verifyPassword(config, buildPlaceholderDn(username, config), password)
      return { ok: false, reason: 'invalid_credentials' }
    }

    const verifyResult = await verifyPassword(config, entry.dn, password)

    if (verifyResult === 'invalid') {
      return { ok: false, reason: 'invalid_credentials' }
    }

    // Group resolution only runs after a successful verification bind (R22
    // -- see module doc): resolving it earlier would make the known-user
    // wrong-password path measurably slower than the unknown-username path.
    const groups = await resolveGroups(serviceClient, entry, config)

    return { ok: true, dn: entry.dn, attributes: normalizeAttributes(entry), groups }
  } catch (err) {
    logger.error({ err: describeError(err) }, 'LDAP directory authentication unavailable')
    return { ok: false, reason: 'unavailable' }
  } finally {
    await serviceClient.unbind().catch(() => {})
  }
}
