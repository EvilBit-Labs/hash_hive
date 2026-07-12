/**
 * Catalogue of error `code`s the `/sign-in/ldap` BetterAuth endpoint
 * (`packages/backend/src/lib/ldap/plugin.ts`, `outcomeToApiError` and the
 * `signInLdap` endpoint handler) throws as `APIError({ code, ... })` (R22:
 * 401 / 403 / 503 / 409 / 500).
 *
 * Exported here, rather than left as bare string literals in
 * `outcomeToApiError`, so:
 *
 * 1. The backend constructs each `APIError`'s `code` from this catalogue --
 *    the type system rejects ad-hoc strings.
 * 2. The frontend (`packages/frontend/src/pages/login.tsx`,
 *    `directoryErrorMessage`) matches against the same catalogue when
 *    mapping a failure to user-facing copy, so the two sides cannot drift
 *    silently.
 */
export const LDAP_SIGNIN_ERROR_CODES = [
  'LDAP_DIRECTORY_UNAVAILABLE',
  'LDAP_INVALID_CREDENTIALS',
  'LDAP_NO_MAPPED_GROUP',
  'LDAP_ROLE_SYNC_BLOCKED',
  'LDAP_ACCOUNT_COLLISION',
  'LDAP_USER_NOT_FOUND_AFTER_PROVISIONING',
  'FAILED_TO_CREATE_SESSION',
] as const

export type LdapSignInErrorCode = (typeof LDAP_SIGNIN_ERROR_CODES)[number]
