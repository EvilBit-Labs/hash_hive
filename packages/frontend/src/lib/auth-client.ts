import type { LdapSignInBody, LdapSignInErrorCode, LdapSignInSuccess } from '@hashhive/shared'

import { createAuthClient } from 'better-auth/react'

/**
 * Resolve the auth base URL from the page origin, tolerating an absent or
 * opaque origin.
 *
 * `window.location.origin` is `"null"` for opaque origins (sandboxed iframes,
 * `file://`, `data:`) and the happy-dom test DOM on Linux surfaces it as `null`
 * too. BetterAuth validates the base URL eagerly and THROWS a `BetterAuthError`
 * on a non-`http(s)` value — and because this client is constructed at module
 * load, that throw takes down every module transitively importing this file
 * (the whole app, and every component test). A real http(s) page always has a
 * usable origin, so the localhost fallback only ever applies in those degenerate
 * environments, where auth calls are mocked anyway.
 */
function resolveAuthBaseUrl(): string {
  const origin = typeof window !== 'undefined' ? window.location?.origin : undefined
  return origin && origin !== 'null' ? origin : 'http://localhost'
}

export const authClient: ReturnType<typeof createAuthClient> = createAuthClient({
  baseURL: resolveAuthBaseUrl(),
})

/**
 * Typed error shape `authClient.$fetch` surfaces for a non-2xx
 * `/sign-in/ldap` response. `code` and (on a 409) `linkRequestId` are the
 * exact JSON body the backend's `outcomeToApiError` (U5) constructs for
 * each `APIError` -- better-fetch spreads the parsed error body onto the
 * returned `error` object alongside `status`/`statusText`.
 */
export interface LdapSignInError {
  status: number
  code?: LdapSignInErrorCode
  message?: string
  linkRequestId?: number
}

/**
 * Directory sign-in call for the login page's directory path (U8, R1,
 * R20, R21).
 *
 * NOT a registered BetterAuth client plugin. `ldap/plugin.ts` (U5)
 * exports a canonical `ldapClientPlugin()` companion via
 * `$InferServerPlugin`, but that inference requires importing the
 * SERVER plugin's return type -- and `@hashhive/frontend` does not (and
 * per AGENTS.md's API-surface boundaries, should not) depend on
 * `@hashhive/backend` as a package. This calls the same endpoint
 * (`POST /sign-in/ldap`, resolved under the client's `/api/auth` base)
 * directly via `authClient.$fetch`, typed only against the shared
 * `LdapSignInBody` wire schema -- no backend import required.
 *
 * `authClient.$fetch` does not participate in BetterAuth's built-in
 * `atomListeners` session-refresh matcher (that hardcoded list only
 * covers the built-in paths like `/sign-in/email`), so a successful call
 * here does not by itself make `authClient.useSession()` observe the new
 * session. The caller must trigger a refresh -- see the `$store.notify`
 * call in `LoginPage`'s directory submit handler.
 */
export async function signInLdap(
  body: LdapSignInBody
): Promise<{ data: LdapSignInSuccess; error: null } | { data: null; error: LdapSignInError }> {
  const { data, error } = await authClient.$fetch<LdapSignInSuccess>('/sign-in/ldap', {
    method: 'POST',
    body,
  })
  if (error) {
    return { data: null, error: error as LdapSignInError }
  }
  return { data, error: null }
}
