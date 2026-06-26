import type { QUEUE_NAMES } from '../config/queue.js'

// ─── Job Priority ────────────────────────────────────────────────────

export const JOB_PRIORITY = {
  HIGH: 1,
  NORMAL: 5,
  LOW: 10,
} as const

export type JobPriority = (typeof JOB_PRIORITY)[keyof typeof JOB_PRIORITY]

// ─── Job Payloads ────────────────────────────────────────────────────

export interface HashListParseJob {
  hashListId: number
  projectId: number
}

export interface TaskGenerationJob {
  campaignId: number
  projectId: number
  attackIds: number[]
  priority: JobPriority
}

export interface HeartbeatMonitorJob {
  triggeredAt: string
}

export interface HealthMonitorJob {
  triggeredAt: string
}

export interface PreemptionJob {
  projectId: number
}

export interface LineCountJob {
  // Wordlists/rulelists are sized by line count; a masklist is sized by its
  // summed mask keyspace (Σ per-line calculateMaskKeyspace), persisted to
  // mask_lists.keyspace (#231). All three fan out to dependent attacks.
  resourceType: 'wordlist' | 'rulelist' | 'masklist'
  resourceId: number
  projectId: number
}

export interface AuditRetentionJob {
  triggeredAt: string
}

// ─── Job Data Discriminated Union ────────────────────────────────────

export type QueueJobMap = {
  // Priority task queues (all accept TaskGenerationJob)
  [QUEUE_NAMES.TASKS_HIGH]: TaskGenerationJob
  [QUEUE_NAMES.TASKS_NORMAL]: TaskGenerationJob
  [QUEUE_NAMES.TASKS_LOW]: TaskGenerationJob

  // Job queues
  [QUEUE_NAMES.HASH_LIST_PARSING]: HashListParseJob
  [QUEUE_NAMES.TASK_GENERATION]: TaskGenerationJob
  [QUEUE_NAMES.HEARTBEAT_MONITOR]: HeartbeatMonitorJob
  [QUEUE_NAMES.HEALTH_MONITOR]: HealthMonitorJob
  [QUEUE_NAMES.PREEMPTION]: PreemptionJob
  [QUEUE_NAMES.LINE_COUNT]: LineCountJob
  [QUEUE_NAMES.AUDIT_RETENTION]: AuditRetentionJob
}
