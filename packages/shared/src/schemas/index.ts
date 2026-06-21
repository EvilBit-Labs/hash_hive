// Side-effect import: extends THIS package's `z` instance with the
// `.openapi(name, metadata?)` prototype method. Must run before any
// `z.object(...)` construction below so all exported schemas have the
// method available at call sites. See `openapi-extension.ts` for the
// rationale (separate `z` instances across packages under Bun's module
// resolution mean `@hono/zod-openapi`'s extension does not reach
// shared schemas without this).
import '../openapi-extension.js'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import { z } from 'zod'

import {
  agentBenchmarks,
  agentErrors,
  agents,
  attacks,
  attackTemplates,
  campaigns,
  crackerBinaries,
  hashItems,
  hashLists,
  hashTypes,
  maskLists,
  operatingSystems,
  projects,
  projectUsers,
  ruleLists,
  tasks,
  users,
  wordLists,
} from '../db/schema.js'

// ─── Users ──────────────────────────────────────────────────────────

export const insertUserSchema = createInsertSchema(users)
export const selectUserSchema = createSelectSchema(users)

// ─── Projects ───────────────────────────────────────────────────────

export const insertProjectSchema = createInsertSchema(projects)
export const selectProjectSchema = createSelectSchema(projects)

// ─── Project Users ──────────────────────────────────────────────────

export const insertProjectUserSchema = createInsertSchema(projectUsers)
export const selectProjectUserSchema = createSelectSchema(projectUsers)

// ─── Operating Systems ──────────────────────────────────────────────

export const insertOperatingSystemSchema = createInsertSchema(operatingSystems)
export const selectOperatingSystemSchema = createSelectSchema(operatingSystems)

// ─── Agents ─────────────────────────────────────────────────────────

export const insertAgentSchema = createInsertSchema(agents)
export const selectAgentSchema = createSelectSchema(agents)

// ─── Agent Errors ───────────────────────────────────────────────────

export const insertAgentErrorSchema = createInsertSchema(agentErrors)
export const selectAgentErrorSchema = createSelectSchema(agentErrors)

// ─── Agent Benchmarks ────────────────────────────────────────────────

export const insertAgentBenchmarkSchema = createInsertSchema(agentBenchmarks)
export const selectAgentBenchmarkSchema = createSelectSchema(agentBenchmarks)

// ─── Hash Types ─────────────────────────────────────────────────────

export const insertHashTypeSchema = createInsertSchema(hashTypes)
export const selectHashTypeSchema = createSelectSchema(hashTypes)

// ─── Hash Lists ─────────────────────────────────────────────────────

export const insertHashListSchema = createInsertSchema(hashLists)
export const selectHashListSchema = createSelectSchema(hashLists)

// ─── Hash Items ─────────────────────────────────────────────────────

export const insertHashItemSchema = createInsertSchema(hashItems)
export const selectHashItemSchema = createSelectSchema(hashItems)

// ─── Word Lists ─────────────────────────────────────────────────────

export const insertWordListSchema = createInsertSchema(wordLists)
export const selectWordListSchema = createSelectSchema(wordLists)

// ─── Rule Lists ─────────────────────────────────────────────────────

export const insertRuleListSchema = createInsertSchema(ruleLists)
export const selectRuleListSchema = createSelectSchema(ruleLists)

// ─── Mask Lists ─────────────────────────────────────────────────────

export const insertMaskListSchema = createInsertSchema(maskLists)
export const selectMaskListSchema = createSelectSchema(maskLists)

// ─── Attack Templates ──────────────────────────────────────────────

export const insertAttackTemplateSchema = createInsertSchema(attackTemplates)
export const selectAttackTemplateSchema = createSelectSchema(attackTemplates)

// ─── Campaigns ──────────────────────────────────────────────────────

export const insertCampaignSchema = createInsertSchema(campaigns)
export const selectCampaignSchema = createSelectSchema(campaigns)

// ─── Attacks ────────────────────────────────────────────────────────

export const insertAttackSchema = createInsertSchema(attacks)
export const selectAttackSchema = createSelectSchema(attacks)

// ─── Tasks ──────────────────────────────────────────────────────────

export const insertTaskSchema = createInsertSchema(tasks)
export const selectTaskSchema = createSelectSchema(tasks)

// ─── Cracker Binaries ───────────────────────────────────────────────

export const insertCrackerBinarySchema = createInsertSchema(crackerBinaries)
export const selectCrackerBinarySchema = createSelectSchema(crackerBinaries)

// ─── Custom API Schemas ─────────────────────────────────────────────

export const loginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
})

/**
 * Inline-attack payload accepted by the transactional `POST /campaigns`
 * path. Distinct from `createAttackRequestSchema` in one important
 * way: `dependencyIndices` here are **0-based indices into the same
 * `attacks[]` array** (since the attacks don't have real DB ids until
 * insert), whereas `createAttackRequestSchema.dependencies` carries
 * **real attack IDs**. The field is named differently to make the
 * semantic split explicit at the wire level.
 */
export const inlineAttackRequestSchema = z
  .object({
    mode: z.number().int().nonnegative(),
    hashTypeId: z.number().int().positive().optional(),
    wordlistId: z.number().int().positive().optional(),
    rulelistId: z.number().int().positive().optional(),
    masklistId: z.number().int().positive().optional(),
    advancedConfiguration: z.record(z.string(), z.unknown()).optional(),
    dependencyIndices: z.array(z.number().int().nonnegative()).optional(),
  })
  .openapi('InlineAttack')

export const createCampaignRequestSchema = insertCampaignSchema
  .pick({
    name: true,
    description: true,
    hashListId: true,
    priority: true,
  })
  .extend({
    /**
     * Optional inline attacks. When supplied, the campaign and its
     * attacks are created in a single transaction with pre-commit
     * DAG validation. Omit (or pass `[]`) to fall back to the legacy
     * single-row insert path.
     */
    attacks: z.array(inlineAttackRequestSchema).optional(),
  })
  .openapi('CreateCampaignRequest')

export const createAttackRequestSchema = insertAttackSchema
  .pick({
    mode: true,
    hashTypeId: true,
    wordlistId: true,
    rulelistId: true,
    masklistId: true,
    advancedConfiguration: true,
    dependencies: true,
  })
  .openapi('CreateAttackRequest')

/**
 * Explicit request schema for creating attack templates.
 * Mirrors the nullable DB columns so PATCH can clear fields back to null.
 * (drizzle-zod insert schemas produce Buffer types for varchar/integer,
 *  so we define this by hand to get proper string/number types.)
 */
export const createAttackTemplateRequestSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  mode: z.number().int().nonnegative(),
  hashTypeId: z.number().int().positive().nullable().optional(),
  wordlistId: z.number().int().positive().nullable().optional(),
  rulelistId: z.number().int().positive().nullable().optional(),
  masklistId: z.number().int().positive().nullable().optional(),
  advancedConfiguration: z.record(z.string(), z.unknown()).nullable().optional(),
  tags: z.array(z.string().min(1).max(100)).max(20).optional(),
})

export const instantiateAttackTemplateResponseSchema = z.object({
  mode: z.number().int(),
  hashTypeId: z.number().int().nullable(),
  wordlistId: z.number().int().nullable(),
  rulelistId: z.number().int().nullable(),
  masklistId: z.number().int().nullable(),
  advancedConfiguration: z.unknown().nullable().optional(),
})

// ─── Resource Management API wire shapes ────────────────────────────
// Extracted to `./resources.ts` when this barrel crossed the 800-line
// ceiling. Re-exported here so consumers keep importing from
// `@hashhive/shared` unchanged.
export {
  createHashListRequestSchema,
  detectHashTypeRequestSchema,
  detectHashTypeResponseSchema,
  fileRefSchema,
  hashCandidateSchema,
  hashItemsPageWireSchema,
  hashItemWireSchema,
  hashListDetailWireSchema,
  hashListStatisticsSchema,
  hashListWireSchema,
  hashTypeWireSchema,
  resourceStatusSchema,
  resourceUpdateEventDataSchema,
  resourceWireSchema,
  setHashListTypeRequestSchema,
} from './resources.js'

// Results API wire shapes + hashcat attack-mode lookup live in
// schemas/results.ts; re-exported here so consumers keep importing
// from `@hashhive/shared` unchanged.
export {
  crackedResultRowSchema,
  HASHCAT_ATTACK_MODE_NAMES,
  listResultsResponseSchema,
  resolveAttackModeName,
} from './results.js'
export type { AttackModeName } from './results.js'

// Hash-lists listing wire shapes (issue #165 / U2). Powers the global
// Results page's hash-list filter dropdown and the hash list detail
// stats card. Re-exported from the barrel so consumers keep importing
// from `@hashhive/shared` unchanged.
export { hashListListResponseSchema, hashListSummarySchema } from './hash-lists.js'

/**
 * Canonical agent status values matching the persisted `agents.status` column.
 * Use this schema wherever the full agent status vocabulary is validated.
 */
export const agentStatusSchema = z.enum(['offline', 'online', 'busy', 'error', 'benchmarked'])

/**
 * Heartbeat status is intentionally a subset of `agentStatusSchema` — agents
 * never self-report as `offline` (that state is set server-side by the
 * heartbeat timeout monitor).
 */
export const benchmarkSubmissionSchema = z.object({
  entries: z
    .array(
      z.object({
        hashcatMode: z.number().int().nonnegative(),
        hashType: z.string().min(1),
        speedHs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        deviceName: z.string().min(1),
      })
    )
    .min(1)
    .refine(
      (entries) => {
        const modes = entries.map((e) => e.hashcatMode)
        return new Set(modes).size === modes.length
      },
      { message: 'entries must not contain duplicate hashcatMode values' }
    ),
  crackerVersion: z.string().min(1).optional(),
})

/**
 * Cracker engines the registry knows about. Hashcat is the default
 * everywhere; new engines are added here when they ship support across
 * the registry, dispatcher, and agent contract.
 *
 * Stored values are always lowercase — see `normalizeEngineName` callers.
 */
export const KNOWN_ENGINES = ['hashcat', 'john'] as const
export type KnownEngineName = (typeof KNOWN_ENGINES)[number]

/**
 * Platform identifiers used in cracker binary keys. Closed set so the
 * dashboard form and the agent contract cannot drift.
 */
export const KNOWN_PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'windows-x64',
  'darwin-x64',
  'darwin-arm64',
] as const
export type KnownPlatformName = (typeof KNOWN_PLATFORMS)[number]

export const engineNameSchema = z.enum(KNOWN_ENGINES)
export const platformNameSchema = z.enum(KNOWN_PLATFORMS)

/**
 * Engine descriptor advertised by an agent in heartbeat capabilities.
 * Lets the server know which cracker engines (hashcat, john, …) the agent
 * runs and at what version. Heartbeat is a wire-format schema — engine
 * names are kept as `string` here (rather than the enum) because legacy
 * agents may report unknown values; consumers downcast via
 * `getPrimaryEngine`/`normalizeEngineName` at the boundary.
 */
export const engineDescriptorSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
})

/**
 * Structured hardware profile reported by agents. Every field is optional
 * so older agents emitting a sparse payload keep working. The dashboard's
 * `HardwareProfileCard` renders this same shape — the schema is the single
 * source of truth for both the wire contract and the rendered fields.
 *
 * `*Mb` keys are canonical; the suffix-less aliases (`total`/`available`/
 * `memory`) are accepted for compatibility with older agent builds and
 * are dropped during a future cleanup pass.
 */
export const agentHardwareProfileSchema = z.object({
  os: z
    .object({
      name: z.string().optional(),
      version: z.string().optional(),
      platform: z.string().optional(),
    })
    .optional(),
  cpu: z
    .object({
      model: z.string().optional(),
      cores: z.number().optional(),
    })
    .optional(),
  ram: z
    .object({
      totalMb: z.number().optional(),
      availableMb: z.number().optional(),
      total: z.number().optional(),
      available: z.number().optional(),
    })
    .optional(),
  gpus: z
    .array(
      z.object({
        model: z.string().optional(),
        driver: z.string().optional(),
        driverVersion: z.string().optional(),
        memoryMb: z.number().optional(),
        memory: z.number().optional(),
      })
    )
    .optional(),
  hashcatVersion: z.string().optional(),
  // Live counters reported on every heartbeat. Kept on the same payload
  // to avoid splitting the agent's contract across two endpoints.
  cpuUsage: z.number().optional(),
  memoryUsage: z.number().optional(),
  temperature: z.number().optional(),
})

/**
 * Worst error-severity bucket observed for an agent in the last 24 hours.
 * Maps to the three-state badge on the agent list page.
 */
export const agentWorstSeveritySchema = z.union([
  z.literal('warning'),
  z.literal('fatal'),
  z.null(),
])

/**
 * Single active task associated with an agent, displayed inline on the
 * agent list row. `null` on `currentTask` indicates the agent has no
 * active task; pending tasks are NOT surfaced here — they appear on the
 * agent detail's tasks endpoint.
 */
export const agentCurrentTaskSchema = z.object({
  id: z.number().int(),
  campaignId: z.number().int(),
  campaignName: z.string(),
  attackId: z.number().int(),
  attackMode: z.number().int(),
  status: z.string(),
})

/**
 * Wire-shape contract for `GET /dashboard/agents/:id/tasks`. `startedAt`
 * and `assignedAt` are serialized as ISO strings (Drizzle `Date` doesn't
 * survive JSON).
 */
export const agentTaskSummarySchema = z.object({
  id: z.number().int(),
  campaignId: z.number().int(),
  campaignName: z.string(),
  attackId: z.number().int(),
  attackMode: z.number().int(),
  status: z.string(),
  progress: z.record(z.string(), z.unknown()),
  startedAt: z.string().nullable(),
  assignedAt: z.string().nullable(),
})

/**
 * Heartbeat-only error severity. Narrower than the standalone
 * `POST /api/v1/agent/errors` endpoint (which accepts
 * `warning | error | fatal` for back-compat with agents posting generic
 * errors): heartbeats classify strictly into `warning` (logged, task
 * continues) or `fatal` (logged, task failed, agent status forced to
 * `error`).
 *
 * Size caps live at the schema boundary so a compromised agent token
 * cannot bloat `agent_errors` with multi-MB rows on every heartbeat.
 *
 * `HEARTBEAT_ERROR_CONTEXT_MAX_CHARS` bounds `context` in JSON-string
 * *characters*, not bytes. `JSON.stringify().length` is simpler than
 * encoding-then-measuring and the worst-case UTF-8 expansion is ~4x —
 * even a fully-multibyte 16K-char payload stays under 64 KB, which is
 * still safely under jsonb-friendly row limits.
 */
export const HEARTBEAT_ERROR_MESSAGE_MAX = 4096
export const HEARTBEAT_ERROR_CONTEXT_MAX_CHARS = 16 * 1024

export const agentHeartbeatErrorSchema = z.object({
  severity: z.enum(['warning', 'fatal']),
  message: z.string().min(1).max(HEARTBEAT_ERROR_MESSAGE_MAX),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .refine(
      (value) =>
        value === undefined || JSON.stringify(value).length <= HEARTBEAT_ERROR_CONTEXT_MAX_CHARS,
      {
        message: `context exceeds ${HEARTBEAT_ERROR_CONTEXT_MAX_CHARS} characters when serialized`,
      }
    ),
})

/**
 * Telemetry view of the task the agent is currently executing. Accepted by
 * the heartbeat endpoint so a fatal heartbeat error can be attributed to a
 * specific task, but progress/speed/temperature are informational only —
 * canonical task progress flows through `POST /agent/tasks/:id/report` and
 * is not written back to the `tasks` table from heartbeat handling.
 */
export const agentHeartbeatCurrentTaskSchema = z.object({
  taskId: z.number().int().positive(),
  progress: z.number().min(0),
  speed: z.number(),
  temperature: z.number().optional(),
})

export const agentHeartbeatSchema = z.object({
  // Status enum is a deliberate superset: `busy` and `benchmarked` are
  // load-bearing for task assignment and benchmark submission. The
  // service layer treats anything other than a fatal-error heartbeat as
  // "agent is reachable" regardless of which non-error literal arrives.
  status: z.enum(['online', 'busy', 'error', 'benchmarked']),
  capabilities: z
    .object({
      hashcatVersion: z.string().optional(),
      engines: z.array(engineDescriptorSchema).optional(),
      gpuDevices: z.array(
        z.object({
          name: z.string(),
          memory: z.number(),
          computeCapability: z.string(),
        })
      ),
    })
    .optional(),
  deviceInfo: agentHardwareProfileSchema.optional(),
  currentTask: agentHeartbeatCurrentTaskSchema.optional(),
  error: agentHeartbeatErrorSchema.optional(),
})

/**
 * Heartbeat response payload. `acknowledged` is always `true` on a 200
 * response (the server accepts the heartbeat). `hasHighPriorityTasks` is
 * set to `true` when pending high-priority tasks exist for the agent's
 * project and capabilities, inviting the agent to request a task
 * immediately rather than waiting for the next assignment poll. The
 * field is **omitted** (not `false`) when no high-priority work is
 * available — agents must treat absence as "no priority signal" rather
 * than receive an explicit negative.
 *
 * This is the shared wire contract; the OpenAPI spec at
 * `packages/openapi/agent-api.yaml` mirrors this shape, and the contract
 * test in `tests/unit/agent-api-contract.test.ts` parses real route
 * responses through this schema to prove the route ↔ shared ↔ OpenAPI
 * triple stays in sync. `.strict()` matches the OpenAPI default of
 * closed objects — extra fields fail parse rather than slip through.
 */
export const agentHeartbeatResponseSchema = z
  .object({
    acknowledged: z.literal(true),
    // Literal `true` (not `boolean`) so the schema mirrors the OpenAPI
    // `enum: [true]` constraint. The schema enforces that *if* the field
    // is present its value is `true`; the omit-when-false **policy**
    // itself lives in the route's conditional spread at
    // `routes/agent/index.ts:103-106`. A future regression that builds
    // the body as `{ hasHighPriorityTasks: someBool }` fails to type-check
    // against the inferred `true | undefined`.
    hasHighPriorityTasks: z.literal(true).optional(),
    // Task preemption (issue #97 U4). Ids of this agent's tasks that were
    // preempted (paused) by higher-priority work; the agent should stop
    // them. **Omitted** (not `[]`) when nothing is preempted, mirroring the
    // `hasHighPriorityTasks` omit-when-empty policy so a strict
    // (`disallowUnknownFields`) agent parser tolerates the additive field.
    stopTaskIds: z.array(z.number().int().positive()).optional(),
  })
  .strict()

// ─── System Health API ─────────────────────────────────────────────

/**
 * Wire identifiers for the four health components surfaced on
 * `/api/v1/control/health`, `/api/v1/dashboard/health`, and the legacy
 * public `/health` envelope. Renamed in issue #156 (HEALTH_VERSION 2.0.0):
 * the prior `'minio'` placeholder was dropped in favor of the neutral
 * `'object_store'` so the wire shape stays vendor-agnostic across
 * SeaweedFS and any future hosted AWS S3 deploy.
 *
 * Single source of truth — backend `services/health.ts`, frontend
 * `hooks/use-system-health.ts`, and the OpenAPI control spec all
 * consume this schema (per AGENTS.md "Wire shapes live in @hashhive/shared").
 */
export const componentNameSchema = z.enum(['database', 'redis', 'object_store', 'queues'])

/** Three-tier component status used on the rich SystemHealth envelope. */
export const componentStatusSchema = z.enum(['healthy', 'degraded', 'unhealthy'])

// ─── Cracker Check-Update API ───────────────────────────────────────

/**
 * Request body for agent cracker update polls. `engine` defaults to
 * `'hashcat'` when omitted so legacy agents keep working unchanged.
 *
 * Engine and platform stay as `string` here (not the enum) so agents
 * advertising an unknown value get a soft `updateAvailable: false`
 * response with a server-side warn log, instead of a 400 that would
 * break the agent's update loop. The dashboard create schema below
 * uses the enum because admin operators must pick a known value.
 */
export const crackerCheckUpdateRequestSchema = z.object({
  engine: z.string().min(1).max(50).optional(),
  version: z.string().min(1).max(100),
  platform: z.string().min(1).max(64),
})

/**
 * Response shape for `/agent/cracker/check-update`. Modeled as a
 * discriminated union on `updateAvailable` so the
 * "if-update-then-URL+version" invariant is expressed at the type level
 * — a server bug returning `{updateAvailable: true}` without a URL no
 * longer type-checks.
 */
export const crackerCheckUpdateResponseSchema = z.discriminatedUnion('updateAvailable', [
  z.object({
    updateAvailable: z.literal(false),
    engine: z.string(),
  }),
  z.object({
    updateAvailable: z.literal(true),
    engine: z.string(),
    latestVersion: z.string(),
    downloadUrl: z.url(),
    expiresIn: z.number().int().positive(),
  }),
])

/**
 * Dashboard request schema for creating a cracker binary record (no file
 * yet — file is uploaded in a follow-up call). Constrained to known
 * engines / platforms because admin uploaders are expected to pick
 * from the registry's supported set.
 */
export const createCrackerBinaryRequestSchema = z.object({
  engine: engineNameSchema,
  version: z.string().min(1).max(100),
  platform: platformNameSchema,
})

export const updateCrackerBinaryRequestSchema = z.object({
  isActive: z.boolean().optional(),
})

// ─── Work Range / Progress ──────────────────────────────────────────

/**
 * Keyspace coordinate carried in `tasks.work_range` jsonb. Mask attacks
 * routinely exceed `Number.MAX_SAFE_INTEGER` (e.g. `?a^12` is ~5.4e23),
 * so the value is a JS Number when it fits in the safe-integer range
 * and a decimal string otherwise. Consumers coerce via `BigInt(...)`
 * before arithmetic.
 */
export const keyspaceCoordSchema = z.union([
  // Cap the number branch at Number.MAX_SAFE_INTEGER. Values above 2^53 - 1
  // have already lost precision by the time Zod sees them - they must
  // travel as decimal strings to round-trip safely.
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z
    .string()
    .regex(/^[0-9]+$/, 'keyspace coord must be a non-negative decimal string')
    .max(64),
])

/**
 * Per-task work range surfaced on `AssignedTask`. Start/end/total share
 * the bigint-safe `keyspaceCoordSchema` shape; `agentSpeedHs` carries
 * the assigning agent's benchmark speed for the task's hash mode and
 * is always a finite, non-negative integer.
 */
export const workRangeSchema = z.object({
  start: keyspaceCoordSchema,
  end: keyspaceCoordSchema,
  total: keyspaceCoordSchema,
  agentSpeedHs: z.number().int().nonnegative(),
})

/**
 * Capability requirements that a task may impose on the agent that
 * claims it. `gpu` and `hashcatMode` are the two recognized keys today;
 * unknown keys are tolerated (passthrough) so agents on older clients
 * keep working when the server adds new requirement axes.
 */
export const requiredCapabilitiesSchema = z
  .object({
    gpu: z.boolean().optional(),
    hashcatMode: z.number().int().nonnegative().optional(),
  })
  .passthrough()

/**
 * Canonical shape of a task descriptor returned from `assignNextTask`
 * and surfaced on the agent API `/tasks/next` route. Timestamp fields
 * use `z.coerce.date()` so the same schema parses both the backend's
 * in-memory `Date` objects (from drizzle) and the ISO-8601 strings
 * frontend/agent clients receive after JSON serialization. Inferred
 * type is `Date` in both cases. Keep in lockstep with the OpenAPI
 * `TaskDescriptor` schema; the `tasks.retry_count` column is
 * `NOT NULL DEFAULT 0`, so `retryCount` is always present.
 */
export const assignedTaskSchema = z.object({
  id: z.number().int().positive(),
  attackId: z.number().int().positive(),
  campaignId: z.number().int().positive(),
  agentId: z.number().int().positive(),
  status: z.string(),
  workRange: workRangeSchema,
  progress: z.unknown(),
  resultStats: z.unknown(),
  requiredCapabilities: requiredCapabilitiesSchema.nullable(),
  assignedAt: z.coerce.date().nullable(),
  startedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  failureReason: z.string().nullable(),
  retryCount: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

// ─── Campaign Dashboard Surface ─────────────────────────────────────
//
// `campaignStatusSchema`, `campaignTaskStatsSchema`,
// `dashboardStatsSchema`, the `TASK_DB_TO_BUCKET` helper, and the
// related task-bucket types live in `./dashboard.ts` so this file
// stays under the per-file budget. Imported + re-exported here so
// other packages continue to import them from `@hashhive/shared`
// unchanged and the local consumer below (`campaignDetailPayloadSchema`)
// can reference `campaignTaskStatsSchema` directly.

import {
  campaignStatusSchema,
  campaignTaskStatsSchema,
  dashboardStatsSchema,
  TASK_DB_TO_BUCKET,
  taskDbStatusSchema,
  type TaskBucket,
  type TaskDbStatus,
} from './dashboard.js'

export {
  campaignStatusSchema,
  campaignTaskStatsSchema,
  dashboardStatsSchema,
  TASK_DB_TO_BUCKET,
  taskDbStatusSchema,
  type TaskBucket,
  type TaskDbStatus,
}

// ─── Task Preemption (issue #97) ────────────────────────────────────
// Defined after the `./dashboard.js` import above so `taskDbStatusSchema` is
// in scope before use (static analyzers flag use-before-declaration even
// though ESM hoists the import).

/**
 * Why a task is in the `paused` state. `'preempted'` = a higher-priority
 * campaign reclaimed the agent (task-level preemption); `'campaign_paused'`
 * is reserved for a future campaign-level pause cascade. Mirrors the
 * `tasks_paused_reason_chk` CHECK constraint in `../db/schema.ts` — keep
 * the two lists in sync.
 */
export const pausedReasonSchema = z.enum(['preempted', 'campaign_paused'])

/** The transitions an audit `task_events` row can record. */
export const taskEventTypeSchema = z.enum(['preempted', 'resumed'])

/**
 * A durable preemption audit row (`task_events`). One row per pause/resume
 * transition. `byCampaignId` is the higher-priority campaign that caused a
 * pause (null on resume / when the campaign was deleted).
 */
export const taskEventSchema = z.object({
  id: z.number().int().positive(),
  taskId: z.number().int().positive().nullable(),
  eventType: taskEventTypeSchema,
  reason: pausedReasonSchema.nullable(),
  // The transition endpoints are persisted task statuses, not free strings —
  // type them as the canonical enum so a reader narrows without re-checking.
  fromStatus: taskDbStatusSchema,
  toStatus: taskDbStatusSchema,
  byCampaignId: z.number().int().positive().nullable(),
  createdAt: z.coerce.date(),
})

/**
 * Request body for changing a running/paused campaign's priority (#97 U7).
 * Single source of truth for the dashboard `PATCH /campaigns/{id}/priority`
 * and control `POST /campaigns/{id}/priority` surfaces so the two routes
 * cannot drift (per the wire-shape-in-@hashhive/shared rule).
 */
export const changeCampaignPriorityRequestSchema = z.object({
  priority: z.number().int().min(1).max(10),
})

/**
 * An agent currently assigned to an active task on a campaign. `progress`
 * is the raw jsonb payload from the task row; consumers should treat it
 * as opaque and prefer the extracted `speedHs` field. `speedHs` is null
 * when the agent has not yet reported a finite, positive speed.
 */
export const campaignActiveAgentSchema = z.object({
  agentId: z.number().int().positive(),
  agentName: z.string(),
  taskId: z.number().int().positive(),
  attackId: z.number().int().positive(),
  attackMode: z.number().int().nonnegative(),
  progress: z.unknown(),
  // Matches the backend extractor: only finite, positive speeds carry
  // through. Zero / negative / NaN / Infinity become null so the ETA
  // computation cannot be poisoned by malformed agent payloads.
  speedHs: z.number().finite().positive().nullable(),
})

/**
 * Sort fields and order accepted by `GET /dashboard/campaigns`. The
 * allowlist mirrors `SORT_COLUMNS` in `services/campaigns.ts` so the
 * route validator, service, and dashboard hook all share one source
 * of truth.
 */
export const campaignSortFieldSchema = z.enum(['name', 'createdAt', 'priority'])
export const campaignSortOrderSchema = z.enum(['asc', 'desc'])

/**
 * Lifecycle actions the dashboard can fire against
 * `POST /dashboard/campaigns/:id/lifecycle`.
 */
export const campaignLifecycleActionSchema = z.enum(['start', 'pause', 'resume', 'stop', 'cancel'])

/**
 * Canonical priority buckets. Backend pegs three integer values
 * (1 = HIGH, 5 = NORMAL, 10 = LOW) via `priorityMap` in
 * `services/campaigns.ts`; any other integer falls back to NORMAL.
 */
export const CAMPAIGN_PRIORITY = { HIGH: 1, NORMAL: 5, LOW: 10 } as const
export const campaignPriorityBucketSchema = z.enum(['high', 'normal', 'low'])

/** Bucket an arbitrary integer priority into the canonical three buckets. */
export function priorityBucket(priority: number): 'high' | 'normal' | 'low' {
  if (priority === CAMPAIGN_PRIORITY.HIGH) return 'high'
  if (priority === CAMPAIGN_PRIORITY.LOW) return 'low'
  return 'normal'
}

/**
 * Query options accepted by `GET /dashboard/campaigns` and consumed by
 * the dashboard's `useCampaigns` hook. Schema-derived so the hook and
 * the route's Zod validator share one source of truth.
 */
export const useCampaignsOptionsSchema = z.object({
  status: z.string().optional(),
  // Allowlist matches the backend route validator so the client cannot
  // accept values that will 400 at the API boundary.
  priority: z
    .union([
      z.literal(CAMPAIGN_PRIORITY.HIGH),
      z.literal(CAMPAIGN_PRIORITY.NORMAL),
      z.literal(CAMPAIGN_PRIORITY.LOW),
    ])
    .optional(),
  sort: campaignSortFieldSchema.optional(),
  order: campaignSortOrderSchema.optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  // When falsy (default), archived campaigns are excluded from the list.
  // Set true to include them (e.g. an "archived" dashboard view). See ADR-0019.
  showArchived: z.boolean().optional(),
})

// ─── Campaign archive / restore (dashboard) ─────────────────────────
//
// Bulk-capable: a single archive/restore is just `ids: [one]`. Each id
// gets an independent per-id outcome so a mixed batch reports which
// succeeded and why the rest did not. See ADR-0019.

export const campaignArchiveRequestSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
})

export const campaignArchiveOutcomeSchema = z.enum([
  'archived',
  'not_found',
  'not_archivable',
  'already_archived',
  // A per-id failure (e.g. a DB error) so one bad id never fails the whole
  // batch with a 500 — the caller sees exactly which ids errored.
  'error',
])

export const campaignArchiveResponseSchema = z.object({
  results: z.array(
    z.object({ id: z.number().int().positive(), outcome: campaignArchiveOutcomeSchema })
  ),
})

export const campaignRestoreOutcomeSchema = z.enum([
  'restored',
  'not_found',
  'not_archived',
  // Per-id failure (see campaignArchiveOutcomeSchema).
  'error',
])

export const campaignRestoreResponseSchema = z.object({
  results: z.array(
    z.object({ id: z.number().int().positive(), outcome: campaignRestoreOutcomeSchema })
  ),
})

/**
 * The attack lifecycle vocabulary. Unlike `campaignStatusSchema`, this
 * governs a *wire-only* field: attack status is derived at read time from
 * the attack's task aggregate plus the parent campaign's status (see the
 * campaign detail payload builder), never persisted to a DB column.
 * `exhausted` = the attack's keyspace was searched with no crack landing
 * here; `completed` = the campaign completed (a crack landed somewhere)
 * while this attack's tasks all reached a terminal-success state.
 */
export const attackStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'completed',
  'exhausted',
  'failed',
])

/**
 * Per-attack row returned by the campaign detail payload. Scoped to
 * the fields the dashboard renders.
 */
export const campaignAttackRowSchema = z.object({
  id: z.number().int().positive(),
  campaignId: z.number().int().positive(),
  mode: z.number().int().nonnegative(),
  // Derived at read time (issue #99), not a persisted column.
  status: attackStatusSchema,
  // Persisted total keyspace as a decimal string (varchar(255), may exceed
  // 2^53); null until computable. ETA is the bigint-safe `number | string`
  // seconds-remaining union, null when uncomputable.
  keyspace: z.string().nullable(),
  // True when `keyspace` is null AND a count/compute is genuinely in flight for
  // an input the attack's mode actually consumes (issue #230). Lets the cell
  // show "Computing..." honestly instead of guessing from `wordlistId`; a
  // settled-null masklist or stray wordlist is false here -> "--".
  keyspacePending: z.boolean(),
  estimatedSecondsRemaining: keyspaceCoordSchema.nullable(),
  wordlistId: z.number().int().positive().nullable(),
  rulelistId: z.number().int().positive().nullable(),
  masklistId: z.number().int().positive().nullable(),
  dependencies: z.array(z.number().int().positive()).nullable(),
})

/**
 * Full response shape of `GET /dashboard/campaigns/:id`. Single
 * authoritative contract that both the route handler and the
 * `useCampaignDetail` hook validate against.
 */
export const campaignDetailPayloadSchema = z.object({
  campaign: selectCampaignSchema,
  attacks: z.array(campaignAttackRowSchema),
  taskStats: campaignTaskStatsSchema,
  activeAgents: z.array(campaignActiveAgentSchema),
})

// ─── Realtime / WebSocket connection ────────────────────────────────

/**
 * The connection-status state machine surfaced by `useEvents` and
 * consumed by the layout-level connection indicator. The six states are
 * the only values the hook will ever emit; consumers can safely switch
 * exhaustively on them.
 */
export const connectionStatusSchema = z.enum([
  'connecting',
  'open',
  'authenticating',
  'reconnecting',
  'fallback',
  'error',
])

/**
 * Request body for `POST /api/v1/dashboard/projects/select`. Sets the
 * server-managed `projectId` on the BetterAuth session after validating
 * project membership.
 */
export const selectProjectRequestSchema = z
  .object({
    projectId: z.number().int().positive(),
  })
  .strict()
  .openapi('SelectProjectRequest')

// ─── Session User / Global RBAC ─────────────────────────────────────

/**
 * Global capability tier for the dashboard API. Stored on `users.roles`
 * and surfaced on `session.user.roles` via BetterAuth -- this requires the
 * `user.additionalFields.roles` declaration in `lib/auth.ts`; without it
 * the column never reaches the session and every `requireRole(...)` check
 * 403s (issue #228). Distinct from `project_users.roles` (per-project
 * membership: admin|contributor|viewer) which gates "what can this account
 * do *within this project*".
 *
 * - `admin`    full access incl. user/project/cracker-binary admin
 * - `operator` campaigns + resources (incl. run/stop/delete)
 * - `analyst`  create + view; no destructive ops
 */
export const userRoleSchema = z.enum(['admin', 'operator', 'analyst'])

/**
 * Wire-shape contract for the active session as exposed to the
 * frontend. `selectedProjectId` is the server-managed scope, sourced
 * from `session.session.projectId` -- never trust a client-supplied
 * header for project scope on the dashboard surface.
 *
 * NOTE: this is NOT the same shape as `meResponseSchema.user` (which
 * uses `id`/`name`/`status` and does not carry `selectedProjectId` --
 * the top-level `meResponseSchema.selectedProjectId` carries it
 * instead). `sessionUserSchema` is reserved for future session-payload
 * contracts (e.g. a Control-API `/users/me` enriched with scope).
 *
 * Also NOT the same shape as the backend internal
 * `AppEnv['Variables']['currentUser']`, which stores the same scope
 * under the internal field name `projectId` (no `selected` prefix).
 * Cross-boundary code consumes `SessionUser` (Zod-validated); internal
 * backend code reads `currentUser.projectId`.
 */
export const sessionUserSchema = z.object({
  userId: z.number().int().positive(),
  email: z.email(),
  roles: z.array(userRoleSchema).min(1),
  selectedProjectId: z.number().int().positive().nullable(),
})

/**
 * Response body for `GET /api/v1/dashboard/auth/me`. `selectedProjectId`
 * is added by issue #159 so the frontend can decide "land on dashboard
 * vs project selector" in a single round-trip without waiting for the
 * WebSocket subscription to hydrate `useUiStore.selectedProjectId`.
 */
export const meResponseSchema = z.object({
  user: z.object({
    id: z.number().int().positive(),
    email: z.email(),
    name: z.string(),
    status: z.string(),
    roles: z.array(userRoleSchema).min(1),
  }),
  projects: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      slug: z.string(),
      // Per-project membership roles -- distinct vocabulary from
      // userRoleSchema (global tier). Kept as z.string() so the
      // shared schema is not coupled to today's three-value enum if
      // per-project roles evolve independently.
      roles: z.array(z.string()).min(1),
    })
  ),
  selectedProjectId: z.number().int().positive().nullable(),
})

// ─── Enrollment tokens (#233 / #114) ────────────────────────────────
// The typeable credential an admin mints to register new agents. The
// secret is never on the wire after mint — only this metadata is. All
// timestamps are ISO strings (the service maps DB Dates before
// returning, so service ReturnType === this wire shape).

export const enrollmentTokenMetadataSchema = z
  .object({
    id: z.number().int().positive(),
    projectId: z.number().int().positive(),
    label: z.string().nullable(),
    isReusable: z.boolean(),
    // null = unlimited (reusable) or unused (one-time).
    maxUses: z.number().int().positive().nullable(),
    useCount: z.number().int().nonnegative(),
    expiresAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('EnrollmentTokenMetadata')

export const createEnrollmentTokenRequestSchema = z
  .object({
    label: z.string().max(255).optional(),
    isReusable: z.boolean().default(false),
    // Only meaningful for reusable tokens. Rejected for one-time tokens
    // below so the illegal combination can't be constructed at the wire
    // boundary (mirrors the DB CHECK constraint).
    maxUses: z.number().int().positive().optional(),
    // Absolute UTC expiry; the route rejects a non-future value.
    expiresAt: z.iso.datetime().optional(),
  })
  .refine((data) => data.isReusable || data.maxUses === undefined, {
    error: 'maxUses is only valid for reusable tokens',
    path: ['maxUses'],
  })
  .openapi('CreateEnrollmentTokenRequest')

export const createEnrollmentTokenResponseSchema = z
  .object({
    // Raw token, shown to the operator exactly once. Never persisted.
    token: z.string(),
    metadata: enrollmentTokenMetadataSchema,
  })
  .openapi('CreateEnrollmentTokenResponse')

export const listEnrollmentTokensResponseSchema = z
  .object({
    tokens: z.array(enrollmentTokenMetadataSchema),
  })
  .openapi('ListEnrollmentTokensResponse')

// Agent-side enrollment (anonymous agent API). The agent presents the
// enrollment token plus a stable, self-generated clientId (for idempotent
// retry) and gets its long-lived bearer token back exactly once.
export const enrollAgentRequestSchema = z
  .object({
    token: z.string().min(1).max(512),
    clientId: z.string().min(1).max(255),
    name: z.string().max(255).optional(),
    // Free-form agent metadata; keys bounded so a single field can't carry
    // an unbounded blob. Total request size is additionally capped by the
    // `bodyLimit` middleware on the /enroll route.
    capabilities: z.record(z.string().max(128), z.unknown()).optional(),
    hardwareProfile: z.record(z.string().max(128), z.unknown()).optional(),
  })
  .openapi('EnrollAgentRequest')

export const enrollAgentResponseSchema = z
  .object({
    agentId: z.number().int().positive(),
    // The agent's long-lived bearer token (agt_<id>_<random>). Shown once.
    token: z.string(),
  })
  .openapi('EnrollAgentResponse')
