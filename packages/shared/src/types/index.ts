import type { z } from 'zod';
import type {
  agentCurrentTaskSchema,
  agentHardwareProfileSchema,
  agentHeartbeatCurrentTaskSchema,
  agentHeartbeatErrorSchema,
  agentHeartbeatSchema,
  agentStatusSchema,
  agentTaskSummarySchema,
  agentWorstSeveritySchema,
  benchmarkSubmissionSchema,
  campaignActiveAgentSchema,
  campaignAttackRowSchema,
  campaignDetailPayloadSchema,
  campaignLifecycleActionSchema,
  campaignPriorityBucketSchema,
  campaignSortFieldSchema,
  campaignSortOrderSchema,
  campaignTaskStatsSchema,
  crackerCheckUpdateRequestSchema,
  crackerCheckUpdateResponseSchema,
  createAttackRequestSchema,
  createAttackTemplateRequestSchema,
  createCampaignRequestSchema,
  createCrackerBinaryRequestSchema,
  engineDescriptorSchema,
  hashCandidateSchema,
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
  selectProjectSchema,
  selectProjectUserSchema,
  selectRuleListSchema,
  selectTaskSchema,
  selectUserSchema,
  selectWordListSchema,
  updateCrackerBinaryRequestSchema,
  useCampaignsOptionsSchema,
  workRangeSchema,
} from '../schemas/index.js';

// ─── Identity & Access ──────────────────────────────────────────────

export type InsertUser = z.infer<typeof insertUserSchema>;
export type SelectUser = z.infer<typeof selectUserSchema>;

export type InsertProject = z.infer<typeof insertProjectSchema>;
export type SelectProject = z.infer<typeof selectProjectSchema>;

export type InsertProjectUser = z.infer<typeof insertProjectUserSchema>;
export type SelectProjectUser = z.infer<typeof selectProjectUserSchema>;

// ─── Agents & Telemetry ─────────────────────────────────────────────

export type InsertOperatingSystem = z.infer<typeof insertOperatingSystemSchema>;
export type SelectOperatingSystem = z.infer<typeof selectOperatingSystemSchema>;

export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type SelectAgent = z.infer<typeof selectAgentSchema>;

export type AgentStatus = z.infer<typeof agentStatusSchema>;

export type InsertAgentError = z.infer<typeof insertAgentErrorSchema>;
export type SelectAgentError = z.infer<typeof selectAgentErrorSchema>;

export type InsertAgentBenchmark = z.infer<typeof insertAgentBenchmarkSchema>;
export type SelectAgentBenchmark = z.infer<typeof selectAgentBenchmarkSchema>;

// ─── Resources ──────────────────────────────────────────────────────

export type InsertHashType = z.infer<typeof insertHashTypeSchema>;
export type SelectHashType = z.infer<typeof selectHashTypeSchema>;

export type InsertHashList = z.infer<typeof insertHashListSchema>;
export type SelectHashList = z.infer<typeof selectHashListSchema>;

export type InsertHashItem = z.infer<typeof insertHashItemSchema>;
export type SelectHashItem = z.infer<typeof selectHashItemSchema>;

export type InsertWordList = z.infer<typeof insertWordListSchema>;
export type SelectWordList = z.infer<typeof selectWordListSchema>;

export type InsertRuleList = z.infer<typeof insertRuleListSchema>;
export type SelectRuleList = z.infer<typeof selectRuleListSchema>;

export type InsertMaskList = z.infer<typeof insertMaskListSchema>;
export type SelectMaskList = z.infer<typeof selectMaskListSchema>;

// ─── Attack Templates ──────────────────────────────────────────────

export type InsertAttackTemplate = z.infer<typeof insertAttackTemplateSchema>;
export type SelectAttackTemplate = z.infer<typeof selectAttackTemplateSchema>;

// ─── Campaign Orchestration ─────────────────────────────────────────

export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type SelectCampaign = z.infer<typeof selectCampaignSchema>;

export type InsertAttack = z.infer<typeof insertAttackSchema>;
export type SelectAttack = z.infer<typeof selectAttackSchema>;

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type SelectTask = z.infer<typeof selectTaskSchema>;

// ─── Campaign Dashboard Surface ─────────────────────────────────────

export type CampaignTaskStats = z.infer<typeof campaignTaskStatsSchema>;
export type CampaignActiveAgent = z.infer<typeof campaignActiveAgentSchema>;
export type CampaignSortField = z.infer<typeof campaignSortFieldSchema>;
export type CampaignSortOrder = z.infer<typeof campaignSortOrderSchema>;
export type CampaignLifecycleAction = z.infer<typeof campaignLifecycleActionSchema>;
export type CampaignPriorityBucket = z.infer<typeof campaignPriorityBucketSchema>;
export type UseCampaignsOptions = z.infer<typeof useCampaignsOptionsSchema>;
export type CampaignAttackRow = z.infer<typeof campaignAttackRowSchema>;
export type CampaignDetailPayload = z.infer<typeof campaignDetailPayloadSchema>;
export { CAMPAIGN_PRIORITY, priorityBucket } from '../schemas/index.js';

// ─── Cracker Binaries ───────────────────────────────────────────────

export type InsertCrackerBinary = z.infer<typeof insertCrackerBinarySchema>;
export type SelectCrackerBinary = z.infer<typeof selectCrackerBinarySchema>;

export type EngineDescriptor = z.infer<typeof engineDescriptorSchema>;

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
export type AgentCapabilities = NonNullable<z.infer<typeof agentHeartbeatSchema>['capabilities']>;

export type CrackerCheckUpdateRequest = z.infer<typeof crackerCheckUpdateRequestSchema>;
export type CrackerCheckUpdateResponse = z.infer<typeof crackerCheckUpdateResponseSchema>;
export type CreateCrackerBinaryRequest = z.infer<typeof createCrackerBinaryRequestSchema>;
export type UpdateCrackerBinaryRequest = z.infer<typeof updateCrackerBinaryRequestSchema>;

export type { KnownEngineName, KnownPlatformName } from '../schemas/index.js';
/** Re-exports of the engine/platform constants and types for callers. */
export { KNOWN_ENGINES, KNOWN_PLATFORMS } from '../schemas/index.js';

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
export type WorkRange = z.infer<typeof workRangeSchema>;

export interface RequiredCapabilities {
  gpu?: boolean;
  hashcatMode?: number;
}

export interface AssignedTask {
  id: number;
  attackId: number;
  campaignId: number;
  agentId: number;
  status: string;
  workRange: WorkRange;
  progress: unknown;
  resultStats: unknown;
  requiredCapabilities: RequiredCapabilities | null;
  assignedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  failureReason: string | null;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── API Request Types ──────────────────────────────────────────────

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type CreateCampaignRequest = z.infer<typeof createCampaignRequestSchema>;
export type InlineAttackRequest = z.infer<typeof inlineAttackRequestSchema>;
export type CreateAttackRequest = z.infer<typeof createAttackRequestSchema>;
export type HashCandidate = z.infer<typeof hashCandidateSchema>;
export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;
export type AgentHeartbeatError = z.infer<typeof agentHeartbeatErrorSchema>;
export type AgentHeartbeatCurrentTask = z.infer<typeof agentHeartbeatCurrentTaskSchema>;
export type AgentHardwareProfile = z.infer<typeof agentHardwareProfileSchema>;
export type BenchmarkSubmission = z.infer<typeof benchmarkSubmissionSchema>;
export type CreateAttackTemplateRequest = z.infer<typeof createAttackTemplateRequestSchema>;
export type InstantiateAttackTemplateResponse = z.infer<
  typeof instantiateAttackTemplateResponseSchema
>;

// ─── Control API ────────────────────────────────────────────────────

/**
 * Metadata for a user's Control API key. Discriminated on `hasKey` so an
 * inconsistent value (`hasKey: true` with `prefix: null`) cannot be
 * constructed at compile time. Backend issues this from `services/auth`;
 * frontend reads it via `use-api-key`.
 */
export type ApiKeyMetadata =
  | { readonly hasKey: false }
  | { readonly hasKey: true; readonly prefix: string; readonly lastUsedAt: string | null };

/**
 * Response from `POST /api/v1/dashboard/auth/me/api-key` (issue/rotate).
 * The raw `token` is shown to the user exactly once and is never
 * persisted server-side; only `metadata` is durable.
 */
export interface IssueApiKeyResponse {
  readonly token: string;
  readonly metadata: Extract<ApiKeyMetadata, { hasKey: true }>;
}

// ─── Agent List / Detail UI shared shapes ───────────────────────────
// All three shapes below are derived from the Zod schemas in
// `schemas/index.ts` per the project's "no manual interfaces" rule —
// backend and frontend share the same inferred types so the wire
// contract is enforceable end-to-end.

export type AgentWorstSeverity = z.infer<typeof agentWorstSeveritySchema>;
export type AgentCurrentTask = z.infer<typeof agentCurrentTaskSchema>;
export type AgentTaskSummary = z.infer<typeof agentTaskSummarySchema>;
