import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import {
  agentBenchmarks,
  agentErrors,
  agents,
  attacks,
  attackTemplates,
  campaigns,
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

export const agentHeartbeatSchema = z.object({
  status: z.enum(['online', 'busy', 'error', 'benchmarked']),
  capabilities: z
    .object({
      hashcatVersion: z.string(),
      gpuDevices: z.array(
        z.object({
          name: z.string(),
          memory: z.number(),
          computeCapability: z.string(),
        })
      ),
    })
    .optional(),
  deviceInfo: z
    .object({
      cpuUsage: z.number(),
      memoryUsage: z.number(),
      temperature: z.number().optional(),
    })
    .optional(),
});
