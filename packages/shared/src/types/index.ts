import type { z } from 'zod'

import type {
  agentCurrentTaskSchema,
  agentHardwareProfileSchema,
  agentHeartbeatCurrentTaskSchema,
  agentHeartbeatErrorSchema,
  agentHeartbeatResponseSchema,
  agentHeartbeatSchema,
  componentNameSchema,
  componentStatusSchema,
  agentStatusSchema,
  agentTaskSummarySchema,
  agentWorstSeveritySchema,
  agentHashcatTuningSchema,
  agentTuningSchema,
  agentHardwareKnobsSchema,
  agentErrorWhitelistSchema,
  agentConfigSchema,
  fleetDefaultConfigSchema,
  configValueSourceSchema,
  effectiveAgentConfigSchema,
  agentConfigSourceMapSchema,
  agentConfigResponseSchema,
  fleetConfigResponseSchema,
  agentListRowWireSchema,
  assignedTaskSchema,
  pausedReasonSchema,
  taskEventSchema,
  taskEventTypeSchema,
  benchmarkSubmissionSchema,
  attackStatusSchema,
  campaignActiveAgentSchema,
  campaignAttackRowSchema,
  campaignDetailPayloadSchema,
  campaignLifecycleActionSchema,
  campaignPriorityBucketSchema,
  campaignSortFieldSchema,
  campaignSortOrderSchema,
  campaignStatusSchema,
  campaignTaskStatsSchema,
  connectionStatusSchema,
  crackerCheckUpdateRequestSchema,
  crackerCheckUpdateResponseSchema,
  changeCampaignPriorityRequestSchema,
  campaignArchiveOutcomeSchema,
  campaignArchiveRequestSchema,
  campaignArchiveResponseSchema,
  campaignRestoreOutcomeSchema,
  campaignRestoreResponseSchema,
  createAttackRequestSchema,
  createAttackTemplateRequestSchema,
  createCampaignRequestSchema,
  createCrackerBinaryRequestSchema,
  createHashListRequestSchema,
  dashboardStatsSchema,
  detectHashTypeRequestSchema,
  detectHashTypeResponseSchema,
  engineDescriptorSchema,
  fileRefSchema,
  hashCandidateSchema,
  hashItemsPageWireSchema,
  hashItemWireSchema,
  hashListDetailWireSchema,
  hashListStatisticsSchema,
  hashListWireSchema,
  hashTypeWireSchema,
  inlineAttackRequestSchema,
  insertAgentBenchmarkSchema,
  insertAgentErrorSchema,
  insertAgentSchema,
  insertAttackSchema,
  insertAttackTemplateSchema,
  insertCampaignSchema,
  insertCrackerBinarySchema,
  insertHashItemSchema,
  insertHashListSchema,
  insertHashTypeSchema,
  insertMaskListSchema,
  insertOperatingSystemSchema,
  insertProjectSchema,
  insertProjectUserSchema,
  insertRuleListSchema,
  insertTaskSchema,
  insertUserSchema,
  insertWordListSchema,
  instantiateAttackTemplateResponseSchema,
  loginRequestSchema,
  meResponseSchema,
  requiredCapabilitiesSchema,
  resourceStatusSchema,
  resourceUpdateEventDataSchema,
  resourceWireSchema,
  selectAgentBenchmarkSchema,
  selectAgentErrorSchema,
  selectAgentSchema,
  selectAttackSchema,
  selectAttackTemplateSchema,
  selectCampaignSchema,
  selectCrackerBinarySchema,
  selectHashItemSchema,
  selectHashListSchema,
  selectHashTypeSchema,
  selectMaskListSchema,
  selectOperatingSystemSchema,
  selectProjectRequestSchema,
  selectProjectSchema,
  selectProjectUserSchema,
  selectRuleListSchema,
  selectTaskSchema,
  selectUserSchema,
  selectWordListSchema,
  sessionUserSchema,
  setHashListTypeRequestSchema,
  updateCrackerBinaryRequestSchema,
  useCampaignsOptionsSchema,
  userRoleSchema,
  workRangeSchema,
  // Results API wire schemas (issue #164)
  crackedResultRowSchema,
  listResultsResponseSchema,
  // Hash-lists listing schemas (issue #165 / U2)
  hashListListResponseSchema,
  hashListSummarySchema,
  // Enrollment tokens (#233 / #114)
  createEnrollmentTokenRequestSchema,
  createEnrollmentTokenResponseSchema,
  enrollAgentRequestSchema,
  enrollAgentResponseSchema,
  enrollmentTokenMetadataSchema,
  listEnrollmentTokensResponseSchema,
  // Audit logs (#105)
  auditActorTypeSchema,
  auditEntityTypeSchema,
  auditActionSchema,
  auditLogSchema,
  auditLogListResponseSchema,
  auditLogQuerySchema,
} from '../schemas/index.js'

// ─── Identity & Access ──────────────────────────────────────────────

export type InsertUser = z.infer<typeof insertUserSchema>
export type SelectUser = z.infer<typeof selectUserSchema>

export type InsertProject = z.infer<typeof insertProjectSchema>
export type SelectProject = z.infer<typeof selectProjectSchema>

export type InsertProjectUser = z.infer<typeof insertProjectUserSchema>
export type SelectProjectUser = z.infer<typeof selectProjectUserSchema>

// ─── Agents & Telemetry ─────────────────────────────────────────────

export type InsertOperatingSystem = z.infer<typeof insertOperatingSystemSchema>
export type SelectOperatingSystem = z.infer<typeof selectOperatingSystemSchema>

export type InsertAgent = z.infer<typeof insertAgentSchema>
export type SelectAgent = z.infer<typeof selectAgentSchema>

export type AgentStatus = z.infer<typeof agentStatusSchema>

export type InsertAgentError = z.infer<typeof insertAgentErrorSchema>
export type SelectAgentError = z.infer<typeof selectAgentErrorSchema>

export type InsertAgentBenchmark = z.infer<typeof insertAgentBenchmarkSchema>
export type SelectAgentBenchmark = z.infer<typeof selectAgentBenchmarkSchema>

// Agent advanced configuration (#104)
export type AgentHashcatTuning = z.infer<typeof agentHashcatTuningSchema>
export type AgentTuning = z.infer<typeof agentTuningSchema>
export type AgentHardwareKnobs = z.infer<typeof agentHardwareKnobsSchema>
export type AgentErrorWhitelist = z.infer<typeof agentErrorWhitelistSchema>
export type AgentConfig = z.infer<typeof agentConfigSchema>
export type FleetDefaultConfig = z.infer<typeof fleetDefaultConfigSchema>
export type ConfigValueSource = z.infer<typeof configValueSourceSchema>
export type EffectiveAgentConfig = z.infer<typeof effectiveAgentConfigSchema>
// Agent config dashboard API response shapes (#104 U5)
export type AgentConfigSourceMap = z.infer<typeof agentConfigSourceMapSchema>
export type AgentConfigResponse = z.infer<typeof agentConfigResponseSchema>
export type FleetConfigResponse = z.infer<typeof fleetConfigResponseSchema>
export type AgentListRowWire = z.infer<typeof agentListRowWireSchema>

// ─── Resources ──────────────────────────────────────────────────────

export type InsertHashType = z.infer<typeof insertHashTypeSchema>
export type SelectHashType = z.infer<typeof selectHashTypeSchema>

export type InsertHashList = z.infer<typeof insertHashListSchema>
export type SelectHashList = z.infer<typeof selectHashListSchema>

export type InsertHashItem = z.infer<typeof insertHashItemSchema>
export type SelectHashItem = z.infer<typeof selectHashItemSchema>

export type InsertWordList = z.infer<typeof insertWordListSchema>
export type SelectWordList = z.infer<typeof selectWordListSchema>

export type InsertRuleList = z.infer<typeof insertRuleListSchema>
export type SelectRuleList = z.infer<typeof selectRuleListSchema>

export type InsertMaskList = z.infer<typeof insertMaskListSchema>
export type SelectMaskList = z.infer<typeof selectMaskListSchema>

// ─── Attack Templates ──────────────────────────────────────────────

export type InsertAttackTemplate = z.infer<typeof insertAttackTemplateSchema>
export type SelectAttackTemplate = z.infer<typeof selectAttackTemplateSchema>

// ─── Campaign Orchestration ─────────────────────────────────────────

export type InsertCampaign = z.infer<typeof insertCampaignSchema>
export type SelectCampaign = z.infer<typeof selectCampaignSchema>

export type InsertAttack = z.infer<typeof insertAttackSchema>
export type SelectAttack = z.infer<typeof selectAttackSchema>

export type InsertTask = z.infer<typeof insertTaskSchema>
export type SelectTask = z.infer<typeof selectTaskSchema>

// ─── Campaign Dashboard Surface ─────────────────────────────────────

export type CampaignTaskStats = z.infer<typeof campaignTaskStatsSchema>
export type CampaignStatus = z.infer<typeof campaignStatusSchema>
export type DashboardStats = z.infer<typeof dashboardStatsSchema>
export type CampaignActiveAgent = z.infer<typeof campaignActiveAgentSchema>
export type CampaignSortField = z.infer<typeof campaignSortFieldSchema>
export type CampaignSortOrder = z.infer<typeof campaignSortOrderSchema>
export type CampaignLifecycleAction = z.infer<typeof campaignLifecycleActionSchema>
export type CampaignPriorityBucket = z.infer<typeof campaignPriorityBucketSchema>
export type UseCampaignsOptions = z.infer<typeof useCampaignsOptionsSchema>
export type CampaignArchiveRequest = z.infer<typeof campaignArchiveRequestSchema>
export type CampaignArchiveOutcome = z.infer<typeof campaignArchiveOutcomeSchema>
export type CampaignArchiveResponse = z.infer<typeof campaignArchiveResponseSchema>
export type CampaignRestoreOutcome = z.infer<typeof campaignRestoreOutcomeSchema>
export type CampaignRestoreResponse = z.infer<typeof campaignRestoreResponseSchema>
export type AttackStatus = z.infer<typeof attackStatusSchema>
export type CampaignAttackRow = z.infer<typeof campaignAttackRowSchema>
export type CampaignDetailPayload = z.infer<typeof campaignDetailPayloadSchema>
export { CAMPAIGN_PRIORITY, priorityBucket } from '../schemas/index.js'

// ─── Cracker Binaries ───────────────────────────────────────────────

export type InsertCrackerBinary = z.infer<typeof insertCrackerBinarySchema>
export type SelectCrackerBinary = z.infer<typeof selectCrackerBinarySchema>

export type EngineDescriptor = z.infer<typeof engineDescriptorSchema>

/**
 * Shape of the agent's `capabilities` JSONB column. Derived from the
 * heartbeat schema so the wire format and the persisted-shape interface
 * cannot drift. `engines` is the forward-looking field; `hashcatVersion`
 * is preserved for back-compat with agents that have not adopted
 * `engines[]` yet (use `getPrimaryEngine` to collapse both into a single
 * record).
 *
 * The schema's `capabilities` field is optional, so we unwrap with
 * `NonNullable` — consumers reading the JSONB column should treat the
 * column itself as optional, not the inner shape.
 */
export type AgentCapabilities = NonNullable<z.infer<typeof agentHeartbeatSchema>['capabilities']>

export type CrackerCheckUpdateRequest = z.infer<typeof crackerCheckUpdateRequestSchema>
export type CrackerCheckUpdateResponse = z.infer<typeof crackerCheckUpdateResponseSchema>
export type CreateCrackerBinaryRequest = z.infer<typeof createCrackerBinaryRequestSchema>
export type UpdateCrackerBinaryRequest = z.infer<typeof updateCrackerBinaryRequestSchema>

export type { KnownEngineName, KnownPlatformName } from '../schemas/index.js'
/** Re-exports of the engine/platform constants and types for callers. */
export { KNOWN_ENGINES, KNOWN_PLATFORMS } from '../schemas/index.js'

// ─── Task Assignment Types ──────────────────────────────────────────

/**
 * Per-task work range surfaced on `AssignedTask`. Inferred from the
 * canonical Zod schema in `packages/shared/src/schemas/index.ts`.
 *
 * `start`, `end`, `total` are JS Numbers when the value fits in
 * `Number.MAX_SAFE_INTEGER` (most attacks) and decimal strings when it
 * overflows (mask attacks with large character classes, e.g. `?a^12`
 * is ~5.4e23). Consumers must coerce via `BigInt(value)` before
 * arithmetic. `agentSpeedHs` is always a finite non-negative integer.
 */
export type WorkRange = z.infer<typeof workRangeSchema>

/**
 * Capability requirements imposed by a task. Inferred from
 * `requiredCapabilitiesSchema` in `@hashhive/shared`. Passthrough
 * keys may carry future requirement axes — consumers should not
 * exhaustively switch on a closed set.
 */
export type RequiredCapabilities = z.infer<typeof requiredCapabilitiesSchema>

/**
 * Canonical assigned-task shape returned from the agent API
 * `/tasks/next`. Inferred from `assignedTaskSchema` so the wire
 * shape and the in-process TypeScript type cannot drift.
 */
export type AssignedTask = z.infer<typeof assignedTaskSchema>

/** Task preemption (issue #97) wire types. */
export type PausedReason = z.infer<typeof pausedReasonSchema>
export type TaskEventType = z.infer<typeof taskEventTypeSchema>
export type TaskEvent = z.infer<typeof taskEventSchema>

// ─── API Request Types ──────────────────────────────────────────────

export type LoginRequest = z.infer<typeof loginRequestSchema>
export type CreateCampaignRequest = z.infer<typeof createCampaignRequestSchema>
export type ChangeCampaignPriorityRequest = z.infer<typeof changeCampaignPriorityRequestSchema>
export type InlineAttackRequest = z.infer<typeof inlineAttackRequestSchema>
export type CreateAttackRequest = z.infer<typeof createAttackRequestSchema>
export type HashCandidate = z.infer<typeof hashCandidateSchema>

// ─── Resource Management API wire types ─────────────────────────────
export type HashListStatistics = z.infer<typeof hashListStatisticsSchema>
export type CreateHashListRequest = z.infer<typeof createHashListRequestSchema>
export type DetectHashTypeRequest = z.infer<typeof detectHashTypeRequestSchema>
export type DetectHashTypeResponse = z.infer<typeof detectHashTypeResponseSchema>
export type ResourceUpdateEventData = z.infer<typeof resourceUpdateEventDataSchema>
export type FileRef = z.infer<typeof fileRefSchema>
export type ResourceStatus = z.infer<typeof resourceStatusSchema>
export type HashListWire = z.infer<typeof hashListWireSchema>
export type CrackedResultRow = z.infer<typeof crackedResultRowSchema>
export type ListResultsResponse = z.infer<typeof listResultsResponseSchema>
export type HashListSummary = z.infer<typeof hashListSummarySchema>
export type HashListListResponse = z.infer<typeof hashListListResponseSchema>
export type HashTypeWire = z.infer<typeof hashTypeWireSchema>
export type ResourceWire = z.infer<typeof resourceWireSchema>
export type HashListDetailWire = z.infer<typeof hashListDetailWireSchema>
export type HashItemWire = z.infer<typeof hashItemWireSchema>
export type HashItemsPageWire = z.infer<typeof hashItemsPageWireSchema>
export type SetHashListTypeRequest = z.infer<typeof setHashListTypeRequestSchema>
export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>
export type AgentHeartbeatError = z.infer<typeof agentHeartbeatErrorSchema>
export type AgentHeartbeatCurrentTask = z.infer<typeof agentHeartbeatCurrentTaskSchema>
export type AgentHeartbeatResponse = z.infer<typeof agentHeartbeatResponseSchema>
export type ComponentName = z.infer<typeof componentNameSchema>
export type ComponentStatus = z.infer<typeof componentStatusSchema>
export type AgentHardwareProfile = z.infer<typeof agentHardwareProfileSchema>
export type BenchmarkSubmission = z.infer<typeof benchmarkSubmissionSchema>
export type CreateAttackTemplateRequest = z.infer<typeof createAttackTemplateRequestSchema>
export type InstantiateAttackTemplateResponse = z.infer<
  typeof instantiateAttackTemplateResponseSchema
>

// ─── Control API ────────────────────────────────────────────────────

/**
 * Metadata for a user's Control API key. Discriminated on `hasKey` so an
 * inconsistent value (`hasKey: true` with `prefix: null`) cannot be
 * constructed at compile time. Backend issues this from `services/auth`;
 * frontend reads it via `use-api-key`.
 */
export type ApiKeyMetadata =
  | { readonly hasKey: false }
  | {
      readonly hasKey: true
      readonly prefix: string
      readonly lastUsedAt: string | null
    }

/**
 * Response from `POST /api/v1/dashboard/auth/me/api-key` (issue/rotate).
 * The raw `token` is shown to the user exactly once and is never
 * persisted server-side; only `metadata` is durable.
 */
export interface IssueApiKeyResponse {
  readonly token: string
  readonly metadata: Extract<ApiKeyMetadata, { hasKey: true }>
}

// ─── Agent List / Detail UI shared shapes ───────────────────────────
// All three shapes below are derived from the Zod schemas in
// `schemas/index.ts` per the project's "no manual interfaces" rule —
// backend and frontend share the same inferred types so the wire
// contract is enforceable end-to-end.

export type AgentWorstSeverity = z.infer<typeof agentWorstSeveritySchema>
export type AgentCurrentTask = z.infer<typeof agentCurrentTaskSchema>

// ─── Realtime / WebSocket connection ────────────────────────────────

/**
 * Frontend WebSocket connection state machine emitted by `useEvents`
 * and consumed by the layout-level connection indicator.
 */
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>

/**
 * Request body for `POST /api/v1/dashboard/projects/select`.
 */
export type SelectProjectRequest = z.infer<typeof selectProjectRequestSchema>
export type AgentTaskSummary = z.infer<typeof agentTaskSummarySchema>

// ─── Session User / Global RBAC ─────────────────────────────────────

/**
 * Global capability tier. See `userRoleSchema` for the meaning of each
 * value. Distinct from per-project membership roles on `projectUsers`.
 */
export type UserRole = z.infer<typeof userRoleSchema>

/**
 * Wire-shape contract for the active session — `userId`, `email`,
 * `roles`, and `selectedProjectId`. `selectedProjectId` mirrors the
 * server-managed BetterAuth `session.session.projectId`.
 *
 * NOTE: this is NOT the same shape as `meResponseSchema.user`, which
 * uses `id`/`name`/`status` and excludes `selectedProjectId` (the
 * top-level `meResponseSchema.selectedProjectId` carries it instead).
 * `SessionUser` is the canonical session-state contract; `MeResponse.user`
 * is the user-profile slice returned on `/auth/me`.
 *
 * Also NOT the same shape as backend `AppEnv['Variables']['currentUser']`,
 * which stores the same scope under the internal field name `projectId`
 * (no `selected` prefix) and is populated by `requireSession` /
 * `requireApiKey`. Cross-boundary code consumes `SessionUser`
 * (Zod-validated); internal backend code reads `currentUser.projectId`.
 */
export type SessionUser = z.infer<typeof sessionUserSchema>

/**
 * Response body for `GET /api/v1/dashboard/auth/me`. Consumed by
 * `packages/frontend/src/stores/auth.ts` to hydrate the auth + UI
 * stores in a single round-trip.
 */
export type MeResponse = z.infer<typeof meResponseSchema>

// ─── Enrollment tokens (#233 / #114) ────────────────────────────────

export type EnrollmentTokenMetadata = z.infer<typeof enrollmentTokenMetadataSchema>
export type CreateEnrollmentTokenRequest = z.infer<typeof createEnrollmentTokenRequestSchema>
export type CreateEnrollmentTokenResponse = z.infer<typeof createEnrollmentTokenResponseSchema>
export type ListEnrollmentTokensResponse = z.infer<typeof listEnrollmentTokensResponseSchema>
export type EnrollAgentRequest = z.infer<typeof enrollAgentRequestSchema>
export type EnrollAgentResponse = z.infer<typeof enrollAgentResponseSchema>

// ─── Task Telemetry ─────────────────────────────────────────────────
// Drizzle-inferred types for the append-only task_telemetry table (U4).
// Not exposed via any API route; used internally by the telemetry service.

import type { taskTelemetry } from '../db/schema.js'

export type TaskTelemetry = typeof taskTelemetry.$inferSelect

// ─── Audit Logs (#105) ──────────────────────────────────────────────
// z.infer types for the audit log wire shapes. Derived from schemas so
// the type contract is always in sync with the Zod validator.

export type AuditActorType = z.infer<typeof auditActorTypeSchema>
export type AuditEntityType = z.infer<typeof auditEntityTypeSchema>
export type AuditAction = z.infer<typeof auditActionSchema>
export type AuditLog = z.infer<typeof auditLogSchema>
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>
export type InsertTaskTelemetry = typeof taskTelemetry.$inferInsert

// ─── Export (#102) ──────────────────────────────────────────────────
import type {
  exportFormatSchema,
  exportQuerySchema,
  exportScopeSchema,
  exportVariantSchema,
} from '../schemas/export.js'

export type ExportVariant = z.infer<typeof exportVariantSchema>
export type ExportFormat = z.infer<typeof exportFormatSchema>
export type ExportScope = z.infer<typeof exportScopeSchema>
export type ExportQuery = z.infer<typeof exportQuerySchema>

// ─── Import (#102) ──────────────────────────────────────────────────
import type {
  importFormatSchema,
  importRequestSchema,
  importSummarySchema,
} from '../schemas/import.js'

export type ImportFormat = z.infer<typeof importFormatSchema>
export type ImportRequest = z.infer<typeof importRequestSchema>
export type ImportSummary = z.infer<typeof importSummarySchema>

// ─── Search (#102) ──────────────────────────────────────────────────
import type { hashSearchResponseSchema, hashSearchResultSchema } from '../schemas/search.js'

export type HashSearchResult = z.infer<typeof hashSearchResultSchema>
export type HashSearchResponse = z.infer<typeof hashSearchResponseSchema>
/** Re-exports of the search pagination constants for callers. */
export { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_MAX_Q_LENGTH } from '../schemas/index.js'
