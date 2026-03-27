import type { z } from 'zod';
import type {
  agentHeartbeatSchema,
  agentStatusSchema,
  benchmarkSubmissionSchema,
  createAttackRequestSchema,
  createCampaignRequestSchema,
  hashCandidateSchema,
  insertAgentBenchmarkSchema,
  insertAgentErrorSchema,
  insertAgentSchema,
  insertAttackSchema,
  insertCampaignSchema,
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
  loginRequestSchema,
  selectAgentBenchmarkSchema,
  selectAgentErrorSchema,
  selectAgentSchema,
  selectAttackSchema,
  selectCampaignSchema,
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

// ─── Campaign Orchestration ─────────────────────────────────────────

export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type SelectCampaign = z.infer<typeof selectCampaignSchema>;

export type InsertAttack = z.infer<typeof insertAttackSchema>;
export type SelectAttack = z.infer<typeof selectAttackSchema>;

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type SelectTask = z.infer<typeof selectTaskSchema>;

// ─── Task Assignment Types ──────────────────────────────────────────

export interface WorkRange {
  start: number;
  end: number;
  total: number;
  agentSpeedHs: number;
}

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
  createdAt: Date;
  updatedAt: Date;
}

// ─── API Request Types ──────────────────────────────────────────────

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type CreateCampaignRequest = z.infer<typeof createCampaignRequestSchema>;
export type CreateAttackRequest = z.infer<typeof createAttackRequestSchema>;
export type HashCandidate = z.infer<typeof hashCandidateSchema>;
export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;
export type BenchmarkSubmission = z.infer<typeof benchmarkSubmissionSchema>;
