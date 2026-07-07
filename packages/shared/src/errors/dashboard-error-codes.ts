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
  // A word/rule/mask list is a reclaimed shell (blob_reclaimed_at IS NOT
  // NULL) — present, but unusable until re-uploaded and checksum-verified.
  // Refused as an attack resource reference (issue #106 U12 / R12).
  'RESOURCE_RECLAIMED',
  // A hash list / word/rule/mask list is archived (archived_at IS NOT
  // NULL) — present, but hidden from listings. Refused as a campaign or
  // attack resource reference so an archived resource can never silently
  // power new work (issue #106 F5 code review).
  'RESOURCE_ARCHIVED',
  // A re-upload targeting a reclaimed shell did not match the original
  // file's checksum — rejected, the resource stays a shell (issue #106
  // U12 / R12).
  'CHECKSUM_MISMATCH',
  // A chunked-upload restore session's `restoreResourceId` points at a
  // resource that exists and is in project scope, but is NOT a reclaimed
  // shell (`blob_reclaimed_at IS NULL`) — restore-via-chunked-upload only
  // resurrects a reclaimed shell (issue #106 F3 code review / R12).
  'RESOURCE_NOT_RECLAIMED',
  'RESOURCE_VALIDATION_FAILED',
  'DUPLICATE_NAME',
  'NOT_DRAFT',
  // Permanent (latched by ADR-0019 / issue #106) — archive-only, refuses
  // hard delete. Used by campaigns (existing, raw c.json) and hash
  // lists/resources (issue #106 U3).
  'NOT_DELETABLE',
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
  // A campaign's non-terminal attacks must share one hashcat mode so the
  // sum-of-ETAs model stays exact (issue #100 R15 / AS1). Rejects attack
  // create/update when the new mode differs from an existing non-terminal
  // sibling attack in the same campaign.
  'ATTACK_MODE_CONFLICT',
  // ─── API key management ───────────────────────────────────────────
  'API_KEY_ISSUE_FAILED',
  'API_KEY_READ_FAILED',
  'API_KEY_REVOKE_FAILED',
  // ─── Enrollment tokens ────────────────────────────────────────────
  'ENROLLMENT_TOKEN_NOT_FOUND',
  'ENROLLMENT_TOKEN_CREATE_FAILED',
  'ENROLLMENT_TOKEN_LIST_FAILED',
  'ENROLLMENT_TOKEN_REVOKE_FAILED',
  // ─── Audit logs ───────────────────────────────────────────────────
  'AUDIT_LOG_LIST_FAILED',
  // ─── Agent configuration (#104) ───────────────────────────────────
  'AGENT_CONFIG_UPDATE_FAILED',
  'FLEET_CONFIG_UPDATE_FAILED',
  'RAW_FLAG_INVALID',
  // Retirement is terminal (ADR-0019 / issue #106 R9, no restore path) --
  // the generic PATCH /agents/:id path refuses to update a retired agent
  // (issue #106 F4 code review).
  'AGENT_RETIRED',
  // ─── Generic ──────────────────────────────────────────────────────
  'INTERNAL_ERROR',
] as const

export type DashboardErrorCode = (typeof DASHBOARD_ERROR_CODES)[number]
