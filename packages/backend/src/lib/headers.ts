/**
 * Shared header-parsing helpers. Centralized so the dashboard
 * (cookie-session auth) and Control API (API-key auth) middleware agree
 * on what a "valid X-Project-Id" looks like.
 */

/**
 * Parse the `X-Project-Id` header into a positive integer or null.
 * Treats absent, non-numeric, zero, and negative values as null so the
 * downstream RBAC layer always sees an unambiguous (number | null).
 */
export function parseProjectIdHeader(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
