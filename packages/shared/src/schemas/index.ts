import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
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
} from '../db/schema.js';

// ─── Users ──────────────────────────────────────────────────────────

export const insertUserSchema = createInsertSchema(users);
export const selectUserSchema = createSelectSchema(users);

// ─── Projects ───────────────────────────────────────────────────────

export const insertProjectSchema = createInsertSchema(projects);
export const selectProjectSchema = createSelectSchema(projects);

// ─── Project Users ──────────────────────────────────────────────────

export const insertProjectUserSchema = createInsertSchema(projectUsers);
export const selectProjectUserSchema = createSelectSchema(projectUsers);

// ─── Operating Systems ──────────────────────────────────────────────

export const insertOperatingSystemSchema = createInsertSchema(operatingSystems);
export const selectOperatingSystemSchema = createSelectSchema(operatingSystems);

// ─── Agents ─────────────────────────────────────────────────────────

export const insertAgentSchema = createInsertSchema(agents);
export const selectAgentSchema = createSelectSchema(agents);

// ─── Agent Errors ───────────────────────────────────────────────────

export const insertAgentErrorSchema = createInsertSchema(agentErrors);
export const selectAgentErrorSchema = createSelectSchema(agentErrors);

// ─── Agent Benchmarks ────────────────────────────────────────────────

export const insertAgentBenchmarkSchema = createInsertSchema(agentBenchmarks);
export const selectAgentBenchmarkSchema = createSelectSchema(agentBenchmarks);

// ─── Hash Types ─────────────────────────────────────────────────────

export const insertHashTypeSchema = createInsertSchema(hashTypes);
export const selectHashTypeSchema = createSelectSchema(hashTypes);

// ─── Hash Lists ─────────────────────────────────────────────────────

export const insertHashListSchema = createInsertSchema(hashLists);
export const selectHashListSchema = createSelectSchema(hashLists);

// ─── Hash Items ─────────────────────────────────────────────────────

export const insertHashItemSchema = createInsertSchema(hashItems);
export const selectHashItemSchema = createSelectSchema(hashItems);

// ─── Word Lists ─────────────────────────────────────────────────────

export const insertWordListSchema = createInsertSchema(wordLists);
export const selectWordListSchema = createSelectSchema(wordLists);

// ─── Rule Lists ─────────────────────────────────────────────────────

export const insertRuleListSchema = createInsertSchema(ruleLists);
export const selectRuleListSchema = createSelectSchema(ruleLists);

// ─── Mask Lists ─────────────────────────────────────────────────────

export const insertMaskListSchema = createInsertSchema(maskLists);
export const selectMaskListSchema = createSelectSchema(maskLists);

// ─── Attack Templates ──────────────────────────────────────────────

export const insertAttackTemplateSchema = createInsertSchema(attackTemplates);
export const selectAttackTemplateSchema = createSelectSchema(attackTemplates);

// ─── Campaigns ──────────────────────────────────────────────────────

export const insertCampaignSchema = createInsertSchema(campaigns);
export const selectCampaignSchema = createSelectSchema(campaigns);

// ─── Attacks ────────────────────────────────────────────────────────

export const insertAttackSchema = createInsertSchema(attacks);
export const selectAttackSchema = createSelectSchema(attacks);

// ─── Tasks ──────────────────────────────────────────────────────────

export const insertTaskSchema = createInsertSchema(tasks);
export const selectTaskSchema = createSelectSchema(tasks);

// ─── Cracker Binaries ───────────────────────────────────────────────

export const insertCrackerBinarySchema = createInsertSchema(crackerBinaries);
export const selectCrackerBinarySchema = createSelectSchema(crackerBinaries);

// ─── Custom API Schemas ─────────────────────────────────────────────

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const createCampaignRequestSchema = insertCampaignSchema.pick({
  name: true,
  description: true,
  hashListId: true,
  priority: true,
});

export const createAttackRequestSchema = insertAttackSchema.pick({
  mode: true,
  hashTypeId: true,
  wordlistId: true,
  rulelistId: true,
  masklistId: true,
  dependencies: true,
});

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
});

export const instantiateAttackTemplateResponseSchema = z.object({
  mode: z.number().int(),
  hashTypeId: z.number().int().nullable(),
  wordlistId: z.number().int().nullable(),
  rulelistId: z.number().int().nullable(),
  masklistId: z.number().int().nullable(),
  advancedConfiguration: z.unknown().nullable().optional(),
});

export const hashCandidateSchema = z.object({
  name: z.string(),
  hashcatMode: z.number().int(),
  category: z.string(),
  confidence: z.number().min(0).max(1),
});

/**
 * Canonical agent status values matching the persisted `agents.status` column.
 * Use this schema wherever the full agent status vocabulary is validated.
 */
export const agentStatusSchema = z.enum(['offline', 'online', 'busy', 'error', 'benchmarked']);

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
        const modes = entries.map((e) => e.hashcatMode);
        return new Set(modes).size === modes.length;
      },
      { message: 'entries must not contain duplicate hashcatMode values' }
    ),
  crackerVersion: z.string().min(1).optional(),
});

/**
 * Cracker engines the registry knows about. Hashcat is the default
 * everywhere; new engines are added here when they ship support across
 * the registry, dispatcher, and agent contract.
 *
 * Stored values are always lowercase — see `normalizeEngineName` callers.
 */
export const KNOWN_ENGINES = ['hashcat', 'john'] as const;
export type KnownEngineName = (typeof KNOWN_ENGINES)[number];

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
] as const;
export type KnownPlatformName = (typeof KNOWN_PLATFORMS)[number];

export const engineNameSchema = z.enum(KNOWN_ENGINES);
export const platformNameSchema = z.enum(KNOWN_PLATFORMS);

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
});

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
});

/**
 * Worst error-severity bucket observed for an agent in the last 24 hours.
 * Maps to the three-state badge on the agent list page.
 */
export const agentWorstSeveritySchema = z.union([
  z.literal('warning'),
  z.literal('fatal'),
  z.null(),
]);

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
});

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
});

/**
 * Heartbeat-only error severity. Narrower than the standalone
 * `POST /api/v1/agent/errors` endpoint (which accepts
 * `warning | error | fatal` for back-compat with agents posting generic
 * errors): heartbeats classify into the explicit `warning | fatal` split
 * the Agent Heartbeat ticket mandates.
 *
 * Size caps are enforced at the boundary: a compromised agent token
 * would otherwise let an attacker bloat `agent_errors` with multi-MB
 * rows every ~30s. The caps mirror similar bounded payloads elsewhere
 * in the agent API surface.
 *
 * `HEARTBEAT_ERROR_CONTEXT_MAX_CHARS` bounds the JSON-serialized
 * `context` field in *characters* (not bytes) because `TextEncoder`
 * isn't part of the ES2022 lib the shared package targets. Worst-case
 * UTF-8 expansion is ~4x, so a 16 K-char cap still keeps row sizes
 * well under jsonb-friendly limits.
 */
export const HEARTBEAT_ERROR_MESSAGE_MAX = 4096;
export const HEARTBEAT_ERROR_CONTEXT_MAX_CHARS = 16 * 1024;

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
});

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
});

export const agentHeartbeatSchema = z.object({
  // The Agent Heartbeat ticket samples `status: 'online' | 'error'` but the
  // wider system already depends on `busy` and `benchmarked` transitions
  // (assignments, benchmark submission), so the enum stays a superset. The
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
});

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
});

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
    downloadUrl: z.string().url(),
    expiresIn: z.number().int().positive(),
  }),
]);

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
});

export const updateCrackerBinaryRequestSchema = z.object({
  isActive: z.boolean().optional(),
});

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
]);

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
});
