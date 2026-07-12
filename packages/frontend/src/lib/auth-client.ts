import type { LdapSignInBody, LdapSignInErrorCode, LdapSignInSuccess } from '@hashhive/shared'

import { createAuthClient } from 'better-auth/react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BetterAuth's inferred type requires internal references that aren't portable
export const authClient: ReturnType<typeof createAuthClient> = createAuthClient({
  baseURL: window.location.origin,
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
