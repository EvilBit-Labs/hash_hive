/**
 * BetterAuth server + client plugin for AD/LDAP directory sign-in (U5 of
 * the AD/LDAP authentication plan,
 * docs/plans/2026-07-12-001-feat-adldap-authentication-support-plan.md).
 * Implements R1, R15, R16, R22, R23.
 *
 * `ldapPlugin(config)` registers `POST /api/auth/sign-in/ldap` via
 * `createAuthEndpoint` and orchestrates the full directory login flow:
 *
 *   1. `authenticateDirectory` (U2) -- search-then-bind against the
 *      directory. `unavailable` -> 503; `invalid_credentials` -> 401.
 *   2. `resolveRole` (U3) -- maps the user's directory groups to a global
 *      role. `null` (no mapped group) -> 403 (R5).
 *   3. `deriveEmail` (U3) -- derives or synthesizes the HashHive email.
 *   4. `resolveDirectoryUser` (U4) -- JIT-provisions, links, or re-syncs
 *      the HashHive user; a collision denial -> 409 with the pending
 *      `ldap_link_requests` row id. A `LocalAdminFloorError` (U6a) thrown
 *      out of the role-resync path -> 403 (never a raw 500).
 *   5. On success, a real BetterAuth session is issued THROUGH CORE
 *      (`ctx.context.internalAdapter.createSession` +
 *      `setSessionCookie`), so `databaseHooks.session.create.before` (the
 *      `projectId` auto-select hook in `lib/auth.ts`) runs exactly as it
 *      does for local email/password sign-in.
 *
 * R15 (no directory-to-local fallthrough) is satisfied structurally: there
 * is no code path in this module that reads or verifies a local password.
 * R16 (no credential cache) is satisfied structurally too: nothing here
 * persists the submitted password beyond the single `authenticateDirectory`
 * call. Never logs the submitted password or the bind secret -- log calls
 * in this module carry only `username`, resolved `role`, and typed outcome
 * reasons.
 *
 * `resolveLdapSignIn` is the pure orchestration core, extracted from the
 * `createAuthEndpoint` handler for the same reason `computeInitialSessionProjectId`
 * was extracted from `databaseHooks.session.create.before` in `lib/auth.ts`:
 * so the branching (which typed outcome each failure mode produces) is
 * unit-testable via plain dependency injection, without standing up
 * BetterAuth's endpoint context or a database. The `createAuthEndpoint`
 * handler is a thin adapter that maps `LdapSignInOutcome` to either a
 * thrown `APIError` (R22) or the session-issuance side effects, which only
 * the real-directory-plus-real-DB e2e test (`tests/db/ldap-signin-e2e.db.test.ts`)
 * exercises.
 *
 * Session-issuance API verified against the installed `better-auth@1.6.11`
 * source (`node_modules/.bun/better-auth@1.6.11+.../dist/api/routes/sign-in.mjs`,
 * `signInEmail`): `ctx.context.internalAdapter.createSession(userId, dontRememberMe)`
 * routes through `createWithHooks(data, "session", ...)`
 * (`dist/db/with-hooks.mjs`), which runs `databaseHooks.session.create.before`
 * -- confirming the `projectId` hook fires for this plugin's session the
 * same way it does for `signInEmail`. `setSessionCookie` is a public export
 * of `better-auth/cookies` (per the package's `exports` map).
 */

import type { UserRole } from '@hashhive/shared'
import type { BetterAuthClientPlugin, BetterAuthPlugin } from 'better-auth'

import { ldapSignInBodySchema } from '@hashhive/shared'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'

import type { LdapConfig } from '../../config/ldap.js'
import type {
  ResolvedDirectoryUser,
  ResolveDirectoryUserInput,
} from '../../services/ldap-provisioning.js'
import type { DirectoryAuthResult } from './types.js'

import { logger } from '../../config/logger.js'
import { resolveDirectoryUser } from '../../services/ldap-provisioning.js'
import { LocalAdminFloorError } from '../../services/local-admin-guard.js'
import { authenticateDirectory } from './client.js'
import { deriveEmail, resolveRole } from './mapping.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const LDAP_SIGN_IN_PATH = '/sign-in/ldap'

/**
 * Mirrors BetterAuth's own built-in rate-limit special rule for every
 * `/sign-in/*` path (10s window, 3 attempts) -- see the installed
 * `better-auth`'s `dist/api/rate-limiter/index.mjs`, `getDefaultSpecialRules()`:
 * `pathMatcher: (path) => path.startsWith("/sign-in") || ...`, `window: 10,
 * max: 3`. That built-in rule already covers `/sign-in/ldap` for free (it
 * starts with `/sign-in`), but this plugin declares the identical policy
 * explicitly so the throttle is documented on the endpoint that needs it
 * (an anonymous, pre-auth path that opens two LDAP connections per
 * request) and does not silently depend on this endpoint's path continuing
 * to start with `/sign-in`. Like every BetterAuth rate limit, this only
 * takes effect when rate limiting is enabled
 * (`options.rateLimit?.enabled ?? isProduction` -- disabled by default
 * outside production, matching `emailAndPassword` sign-in's own posture).
 */
const RATE_LIMIT_WINDOW_SECONDS = 10
const RATE_LIMIT_MAX_ATTEMPTS = 3

// ─── Pure orchestration core ────────────────────────────────────────────────

export type LdapSignInOutcome =
  | { kind: 'success'; user: ResolvedDirectoryUser }
  | { kind: 'invalid_credentials' }
  | { kind: 'unavailable' }
  | { kind: 'no_mapped_group' }
  | { kind: 'role_sync_blocked'; reason: string }
  | { kind: 'collision'; linkRequestId: number }

/** Injectable seams for `resolveLdapSignIn`, so unit tests can substitute fakes without `mock.module`. */
export interface LdapSignInDependencies {
  authenticateDirectory: (
    username: string,
    password: string,
    config: LdapConfig
  ) => Promise<DirectoryAuthResult>
  resolveRole: (
    groups: readonly string[],
    groupRoleMap: LdapConfig['groupRoleMap']
  ) => UserRole | null
  deriveEmail: (
    attributes: Readonly<Record<string, string>>,
    username: string,
    realm: string,
    emailAttribute: string
  ) => string
  resolveDirectoryUser: (
    input: ResolveDirectoryUserInput
  ) => ReturnType<typeof resolveDirectoryUser>
}

const defaultDependencies: LdapSignInDependencies = {
  authenticateDirectory,
  resolveRole,
  deriveEmail,
  resolveDirectoryUser,
}

/**
 * Orchestrates the client -> mapping -> provisioning pipeline and returns a
 * typed outcome. Never throws for an expected failure mode (invalid creds,
 * unavailable directory, no mapped group, collision, role-sync-blocked) --
 * `LdapSignInOutcome` is the exhaustive contract the `createAuthEndpoint`
 * handler maps to an HTTP status (R22). An unexpected error (a bug, not a
 * known domain outcome) still propagates uncaught, same as every other
 * guarded mutation path in this codebase.
 */
export async function resolveLdapSignIn(
  input: { username: string; password: string },
  config: LdapConfig,
  deps: LdapSignInDependencies = defaultDependencies
): Promise<LdapSignInOutcome> {
  const authResult = await deps.authenticateDirectory(input.username, input.password, config)

  if (!authResult.ok) {
    if (authResult.reason === 'unavailable') {
      // authenticateDirectory (U2) already logs the underlying error via
      // pino at error level -- this is a higher-level "the sign-in attempt
      // was denied for this reason" event, not a duplicate of that log.
      logger.warn({ username: input.username }, 'ldap sign-in denied: directory unavailable')
      return { kind: 'unavailable' }
    }
    logger.warn({ username: input.username }, 'ldap sign-in denied: invalid credentials')
    return { kind: 'invalid_credentials' }
  }

  const role = deps.resolveRole(authResult.groups, config.groupRoleMap)
  if (role === null) {
    logger.warn({ username: input.username }, 'ldap sign-in denied: no mapped group (R5)')
    return { kind: 'no_mapped_group' }
  }

  const email = deps.deriveEmail(
    authResult.attributes,
    input.username,
    config.realm,
    config.emailAttribute
  )

  let resolution: Awaited<ReturnType<typeof resolveDirectoryUser>>
  try {
    resolution = await deps.resolveDirectoryUser({ username: input.username, email, role })
  } catch (err) {
    if (err instanceof LocalAdminFloorError) {
      logger.warn(
        { username: input.username, reason: err.message },
        'ldap sign-in denied: role sync blocked by the local-admin floor guard'
      )
      return { kind: 'role_sync_blocked', reason: err.message }
    }
    throw err
  }

  if (!resolution.ok) {
    logger.warn(
      { username: input.username, linkRequestId: resolution.linkRequestId },
      'ldap sign-in denied: email collision, surfaced for admin reconciliation (R11)'
    )
    return { kind: 'collision', linkRequestId: resolution.linkRequestId }
  }

  logger.info(
    { userId: resolution.user.id, username: input.username, role },
    'ldap sign-in: success'
  )
  return { kind: 'success', user: resolution.user }
}

/** Maps a non-success `LdapSignInOutcome` to the typed `APIError` R22 requires (never a raw 500). Exported for direct unit testing of the outcome -> status mapping. */
export function outcomeToApiError(
  outcome: Exclude<LdapSignInOutcome, { kind: 'success' }>
): InstanceType<typeof APIError> {
  switch (outcome.kind) {
    case 'unavailable':
      return new APIError('SERVICE_UNAVAILABLE', {
        code: 'LDAP_DIRECTORY_UNAVAILABLE',
        message: 'Directory unavailable',
      })
    case 'invalid_credentials':
      return new APIError('UNAUTHORIZED', {
        code: 'LDAP_INVALID_CREDENTIALS',
        message: 'Invalid directory username or password',
      })
    case 'no_mapped_group':
      return new APIError('FORBIDDEN', {
        code: 'LDAP_NO_MAPPED_GROUP',
        message: 'Your directory account is not a member of a group mapped to HashHive access',
      })
    case 'role_sync_blocked':
      return new APIError('FORBIDDEN', {
        code: 'LDAP_ROLE_SYNC_BLOCKED',
        message: 'This role change would remove the last local administrator',
      })
    case 'collision':
      return new APIError('CONFLICT', {
        code: 'LDAP_ACCOUNT_COLLISION',
        message:
          'This directory identity matches an existing HashHive account with a local password. Contact an admin to reconcile.',
        linkRequestId: outcome.linkRequestId,
      })
    default: {
      // Exhaustiveness guard: `outcome` narrows to `never` here once every
      // LdapSignInOutcome variant is handled above, so a future variant
      // added to the union without a matching case fails loudly at runtime
      // (and at compile time, via the `never` assignment) instead of
      // silently falling through to an undefined return.
      const unhandled: never = outcome
      throw new Error(`ldap plugin: unhandled sign-in outcome ${JSON.stringify(unhandled)}`)
    }
  }
}

// ─── BetterAuth server plugin ───────────────────────────────────────────────

/**
 * Builds the `ldap` BetterAuth server plugin bound to a resolved
 * `LdapConfig` (produced by `config/ldap.ts`'s `getLdapConfig`). Callers
 * (`lib/auth.ts`) construct this only when `LDAP_ENABLED`.
 */
export function ldapPlugin(config: LdapConfig): BetterAuthPlugin {
  return {
    id: 'ldap',
    endpoints: {
      signInLdap: createAuthEndpoint(
        LDAP_SIGN_IN_PATH,
        { method: 'POST', body: ldapSignInBodySchema },
        async (ctx) => {
          const outcome = await resolveLdapSignIn(ctx.body, config)

          if (outcome.kind !== 'success') {
            throw outcomeToApiError(outcome)
          }

          // Fetch the full BetterAuth user row -- resolveDirectoryUser (U4)
          // only returns the narrow ResolvedDirectoryUser shape, but
          // setSessionCookie needs the full user record BetterAuth core
          // expects (it is a no-op write here; cookieCache is disabled in
          // this deployment, so the extra fields never leave the process).
          const fullUser = await ctx.context.internalAdapter.findUserById(String(outcome.user.id))
          if (!fullUser) {
            throw new APIError('INTERNAL_SERVER_ERROR', {
              code: 'LDAP_USER_NOT_FOUND_AFTER_PROVISIONING',
              message: 'Directory user resolved but could not be loaded',
            })
          }

          // Routes through BetterAuth core (createWithHooks) so
          // databaseHooks.session.create.before (the projectId auto-select
          // hook in lib/auth.ts) runs identically to local email/password
          // sign-in. See the module doc for the source citation.
          const session = await ctx.context.internalAdapter.createSession(
            String(outcome.user.id),
            false
          )
          if (!session) {
            throw new APIError('INTERNAL_SERVER_ERROR', {
              code: 'FAILED_TO_CREATE_SESSION',
              message: 'Failed to create session',
            })
          }

          await setSessionCookie(ctx, { session, user: fullUser }, false)

          return ctx.json({
            token: session.token,
            user: {
              id: outcome.user.id,
              email: outcome.user.email,
              name: outcome.user.name,
              roles: outcome.user.roles,
            },
          })
        }
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path: string) => path === LDAP_SIGN_IN_PATH,
        window: RATE_LIMIT_WINDOW_SECONDS,
        max: RATE_LIMIT_MAX_ATTEMPTS,
      },
    ],
  } satisfies BetterAuthPlugin
}

// ─── BetterAuth client plugin ───────────────────────────────────────────────

/**
 * Client-side companion to `ldapPlugin`, exposing `authClient.signIn.ldap(...)`
 * via BetterAuth's standard `$InferServerPlugin` inference (kebab-case path
 * segments become camelCase: `/sign-in/ldap` -> `signIn.ldap`).
 *
 * NOT currently wired into `packages/frontend/src/lib/auth-client.ts` --
 * `@hashhive/frontend` does not (and per AGENTS.md's API-surface boundaries,
 * should not) depend on `@hashhive/backend` as a package, so this type-only
 * inference is only consumable from within the backend package. U8 (frontend
 * directory login) defines its own small client-side entry against the
 * shared `LdapSignInBody` wire type instead; this export documents the
 * canonical BetterAuth server+client plugin pair for reference and is
 * exercised indirectly through `ldapPlugin`'s own endpoint tests.
 */
export function ldapClientPlugin(): BetterAuthClientPlugin {
  return {
    id: 'ldap',
    // BetterAuth's documented client-plugin inference marker (see
    // "Creating a client plugin" in the BetterAuth plugin-authoring docs):
    // an empty object cast to the server plugin's return type, used only
    // by the type system to infer endpoint paths -- never read at runtime.
    // oxlint-disable-next-line no-unsafe-type-assertion -- framework-mandated pattern, type-only marker
    $InferServerPlugin: {} as ReturnType<typeof ldapPlugin>,
  } satisfies BetterAuthClientPlugin
}
