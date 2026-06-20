/**
 * Catalogue of error codes the Dashboard API surface returns in the
 * `{ error: { code, message } }` envelope. Exported here so:
 *
 * 1. The backend (`packages/backend/src/lib/dashboard-errors.ts`) can
 *    constrain the `dashboardError(c, status, code, message)` helper
 *    to known codes -- the type system rejects ad-hoc strings.
 * 2. The frontend can exhaustive-switch over `DashboardErrorCode` when
 *    mapping API errors to user-facing messages.
 *
 * Add new codes here as new domains land; the helper and downstream
 * consumers will surface unknown-code drift at build time.
 *
 * Categories below are reading conveniences only -- the union is flat.
 */
export const DASHBOARD_ERROR_CODES = [
  // ─── Auth / RBAC (middleware-emitted) ─────────────────────────────
  'AUTH_TOKEN_INVALID',
  'AUTHZ_INSUFFICIENT_PERMISSIONS',
  'AUTHZ_PROJECT_ACCESS_DENIED',
  'AUTHZ_SESSION_ROLLBACK_FAILED',
  'CSRF_ORIGIN_MISMATCH',
  'PROJECT_NOT_SELECTED',
  // ─── Validation ───────────────────────────────────────────────────
  'VALIDATION_ERROR',
  // ─── Resource lifecycle ───────────────────────────────────────────
  'RESOURCE_NOT_FOUND',
  'RESOURCE_IN_USE',
  'RESOURCE_MISSING',
  'RESOURCE_VALIDATION_FAILED',
  'DUPLICATE_NAME',
  'NOT_DRAFT',
  'INVALID_TRANSITION',
  'STALE_STATE',
  'DELETE_FAILED',
  // ─── Cracker binary management ────────────────────────────────────
  'CRACKER_CREATE_FAILED',
  'CRACKER_DELETE_FAILED',
  'CRACKER_DUPLICATE',
  'CRACKER_GET_FAILED',
  'CRACKER_LIST_FAILED',
  'CRACKER_NOT_FOUND',
  'CRACKER_STORAGE_DELETE_FAILED',
  'CRACKER_UPDATE_FAILED',
  'CRACKER_UPLOAD_FAILED',
  // ─── Chunked upload ───────────────────────────────────────────────
  'UPLOAD_INIT_FAILED',
  'UPLOAD_PART_FAILED',
  'UPLOAD_COMPLETE_FAILED',
  'UPLOAD_ABORT_FAILED',
  'UPLOAD_SESSION_MISMATCH',
  'LENGTH_REQUIRED',
  'PAYLOAD_TOO_LARGE',
  'STORAGE_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  // ─── Campaign DAG ─────────────────────────────────────────────────
  'DAG_INVALID',
  'TASK_GENERATION_FAILED',
  // ─── API key management ───────────────────────────────────────────
  'API_KEY_ISSUE_FAILED',
  'API_KEY_READ_FAILED',
  'API_KEY_REVOKE_FAILED',
  // ─── Enrollment tokens ────────────────────────────────────────────
  'ENROLLMENT_TOKEN_NOT_FOUND',
  'ENROLLMENT_TOKEN_CREATE_FAILED',
  'ENROLLMENT_TOKEN_LIST_FAILED',
  'ENROLLMENT_TOKEN_REVOKE_FAILED',
  // ─── Generic ──────────────────────────────────────────────────────
  'INTERNAL_ERROR',
] as const

export type DashboardErrorCode = (typeof DASHBOARD_ERROR_CODES)[number]
