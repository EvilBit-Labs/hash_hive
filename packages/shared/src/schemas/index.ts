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

export const agentHeartbeatSchema = z.object({
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
