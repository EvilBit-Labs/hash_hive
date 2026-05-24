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
}
