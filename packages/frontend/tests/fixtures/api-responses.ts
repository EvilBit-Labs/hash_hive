/**
 * Factory functions for mock API responses.
 * All factories return plain objects matching backend response shapes.
 */

import type {
  CampaignActiveAgent,
  CampaignAttackRow,
  CampaignTaskStats,
  CrackedResultRow,
  FileRef,
  ResourceStatus,
} from '@hashhive/shared'

interface MockUser {
  id: number
  email: string
  name: string
  status: string
}

interface MockProject {
  id: number
  name: string
  slug: string
  roles: string[]
}

interface MockLoginResponseOptions {
  user?: Partial<MockUser>
  selectedProjectId?: number
}

export function mockLoginResponse(options: MockLoginResponseOptions = {}) {
  return {
    user: {
      id: 1,
      email: 'admin@hashhive.local',
      name: 'Admin User',
      status: 'active',
      ...options.user,
    },
    ...(options.selectedProjectId !== undefined
      ? { selectedProjectId: options.selectedProjectId }
      : {}),
  }
}

interface MockMeResponseOptions {
  user?: Partial<MockUser>
  projectCount?: number
  projects?: MockProject[]
  selectedProjectId?: number | null
}

export function mockMeResponse(options: MockMeResponseOptions = {}) {
  const projectCount = options.projectCount ?? 2
  const projects =
    options.projects ??
    Array.from({ length: projectCount }, (_, i) => ({
      id: i + 1,
      name: `Project ${i + 1}`,
      slug: `project-${i + 1}`,
      roles: ['admin'],
    }))

  // Always include selectedProjectId so the response shape matches the
  // post-#159 MeResponse contract from @hashhive/shared. Default to
  // null (multi-project pre-selector); callers can override.
  const selectedProjectId =
    options.selectedProjectId === undefined ? null : options.selectedProjectId

  return {
    user: {
      id: 1,
      email: 'admin@hashhive.local',
      name: 'Admin User',
      projects: projects.map((p) => ({
        projectId: p.id,
        projectName: p.name,
        roles: p.roles,
      })),
      ...options.user,
    },
    projects,
    selectedProjectId,
  }
}

interface MockDashboardStatsOptions {
  agents?: Partial<{ total: number; online: number; offline: number; error: number }>
  campaigns?: Partial<{
    total: number
    draft: number
    running: number
    paused: number
    completed: number
  }>
  tasks?: Partial<{
    total: number
    pending: number
    running: number
    completed: number
    failed: number
  }>
  cracked?: Partial<{ total: number }>
}

export function mockDashboardStats(options: MockDashboardStatsOptions = {}) {
  return {
    agents: {
      total: 5,
      online: 3,
      offline: 2,
      error: 0,
      ...options.agents,
    },
    campaigns: {
      total: 10,
      draft: 2,
      running: 3,
      paused: 1,
      completed: 4,
      ...options.campaigns,
    },
    tasks: {
      total: 50,
      pending: 10,
      running: 15,
      completed: 20,
      failed: 5,
      ...options.tasks,
    },
    cracked: {
      total: 42,
      ...options.cracked,
    },
  }
}

interface MockProjectsResponseOptions {
  count?: number
  projects?: Array<Partial<MockProject>>
}

export function mockProjectsResponse(options: MockProjectsResponseOptions = {}) {
  const count = options.count ?? 2
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Project ${i + 1}`,
    slug: `project-${i + 1}`,
    roles: ['admin'],
    ...options.projects?.[i],
  }))
}

// --- Agent fixtures ---

interface MockAgent {
  id: number
  name: string
  status: string
  lastSeenAt: string | null
  projectId: number
  capabilities: Record<string, unknown> | null
  hardwareProfile: Record<string, unknown> | null
  createdAt: string
}

interface MockAgentsResponseOptions {
  count?: number
  agents?: Array<Partial<MockAgent>>
}

export function mockAgentsResponse(options: MockAgentsResponseOptions = {}) {
  const count = options.count ?? 3
  const agents = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Agent ${i + 1}`,
    status: ['online', 'offline', 'busy'][i % 3] as string,
    lastSeenAt: new Date().toISOString(),
    projectId: 1,
    capabilities: null,
    hardwareProfile: null,
    createdAt: new Date().toISOString(),
    ...options.agents?.[i],
  }))
  return { agents, total: agents.length }
}

interface MockAgentResponseOptions {
  agent?: Partial<MockAgent>
}

export function mockAgentResponse(options: MockAgentResponseOptions = {}) {
  return {
    agent: {
      id: 1,
      name: 'Rig Alpha',
      status: 'online',
      lastSeenAt: new Date().toISOString(),
      projectId: 1,
      capabilities: { hashModes: [0, 100, 1400] },
      hardwareProfile: { gpu: 'RTX 4090', vram: '24GB' },
      createdAt: new Date().toISOString(),
      ...options.agent,
    },
  }
}

interface MockAgentError {
  id: number
  agentId: number
  severity: string
  message: string
  metadata: Record<string, unknown> | null
  createdAt: string
}

interface MockAgentErrorsResponseOptions {
  count?: number
  errors?: Array<Partial<MockAgentError>>
}

export function mockAgentErrorsResponse(options: MockAgentErrorsResponseOptions = {}) {
  const count = options.count ?? 2
  const errors = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    agentId: 1,
    severity: i === 0 ? 'critical' : 'warning',
    message: `Error message ${i + 1}`,
    metadata: null,
    createdAt: new Date().toISOString(),
    ...options.errors?.[i],
  }))
  return { errors }
}

// --- Campaign fixtures ---

interface MockCampaign {
  id: number
  name: string
  description: string | null
  status: string
  projectId: number
  hashListId: number
  priority: number
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

interface MockCampaignsResponseOptions {
  count?: number
  campaigns?: Array<Partial<MockCampaign>>
}

export function mockCampaignsResponse(options: MockCampaignsResponseOptions = {}) {
  const count = options.count ?? 3
  const campaigns = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Campaign ${i + 1}`,
    description: null,
    status: ['draft', 'running', 'completed'][i % 3] as string,
    projectId: 1,
    hashListId: 1,
    priority: 5,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ...options.campaigns?.[i],
  }))
  return { campaigns, total: campaigns.length }
}

// Derive from the shared wire type so fixtures cannot drift from the contract
// (per AGENTS.md). Carries the read-derived status enum + keyspace + ETA.
type MockAttack = CampaignAttackRow

// Fixture shapes derive from the shared Zod-inferred wire types so test
// data cannot drift from runtime contracts. The shared types come from
// `@hashhive/shared`'s campaign-dashboard schemas.

interface MockCampaignDetailResponseOptions {
  campaign?: Partial<MockCampaign>
  attacks?: Array<Partial<MockAttack>>
  taskStats?: Partial<CampaignTaskStats>
  activeAgents?: Array<Partial<CampaignActiveAgent>>
}

export function mockCampaignDetailResponse(options: MockCampaignDetailResponseOptions = {}) {
  const campaign = {
    id: 1,
    name: 'NTLM Campaign',
    description: 'Crack NTLM hashes',
    status: 'draft',
    projectId: 1,
    hashListId: 1,
    priority: 5,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ...options.campaign,
  }

  const attacks = options.attacks
    ? options.attacks.map(
        (a, i): MockAttack => ({
          id: i + 1,
          campaignId: campaign.id,
          mode: 0,
          status: 'pending',
          keyspace: null,
          estimatedSecondsRemaining: null,
          wordlistId: null,
          rulelistId: null,
          masklistId: null,
          dependencies: null,
          ...a,
        })
      )
    : [
        {
          id: 1,
          campaignId: campaign.id,
          mode: 0,
          status: 'pending',
          keyspace: null,
          estimatedSecondsRemaining: null,
          wordlistId: 1,
          rulelistId: null,
          masklistId: null,
          dependencies: null,
        } satisfies MockAttack,
      ]

  const taskStats: CampaignTaskStats = {
    total: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    ...options.taskStats,
  }

  const activeAgents = (options.activeAgents ?? []).map((agent, i) => ({
    agentId: i + 1,
    agentName: `Rig ${i + 1}`,
    taskId: i + 1,
    attackId: 1,
    attackMode: 0,
    progress: null,
    speedHs: null,
    ...agent,
  }))

  return { campaign, attacks, taskStats, activeAgents }
}

// --- Resource fixtures ---

interface MockHashList {
  id: number
  name: string
  projectId: number
  hashTypeId: number | null
  hashCount: number
  crackedCount: number
  status: ResourceStatus
  fileRef: FileRef | null
  createdAt: string
}

interface MockHashListsResponseOptions {
  count?: number
  hashLists?: Array<Partial<MockHashList>>
}

export function mockHashListsResponse(options: MockHashListsResponseOptions = {}) {
  const count = options.count ?? 2
  const hashLists = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Hash List ${i + 1}`,
    projectId: 1,
    hashTypeId: 1000,
    hashCount: 100 * (i + 1),
    crackedCount: 10 * (i + 1),
    status: 'ready',
    fileRef: null,
    createdAt: new Date().toISOString(),
    ...options.hashLists?.[i],
  }))
  return { hashLists }
}

interface MockResource {
  id: number
  name: string
  projectId: number
  status: ResourceStatus
  fileSize: number | null
  fileRef: FileRef | null
  createdAt: string
}

interface MockResourcesResponseOptions {
  count?: number
  resources?: Array<Partial<MockResource>>
}

export function mockResourcesResponse(options: MockResourcesResponseOptions = {}) {
  const count = options.count ?? 2
  const resources = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Resource ${i + 1}`,
    projectId: 1,
    status: 'ready',
    fileSize: null,
    fileRef: null,
    createdAt: new Date().toISOString(),
    ...options.resources?.[i],
  }))
  return { resources, total: resources.length }
}

interface MockHashCandidate {
  name: string
  hashcatMode: number
  category: string
  confidence: number
}

interface MockHashTypeGuessResponseOptions {
  hashValue?: string
  candidates?: Array<Partial<MockHashCandidate>>
  identified?: boolean
}

export function mockHashTypeGuessResponse(options: MockHashTypeGuessResponseOptions = {}) {
  return {
    hashValue: options.hashValue ?? '5f4dcc3b5aa765d61d8327deb882cf99',
    identified: options.identified ?? true,
    candidates: options.candidates
      ? options.candidates.map((c, i) => ({
          name: `Hash Type ${i + 1}`,
          hashcatMode: 0,
          category: 'Raw Hash',
          confidence: 0.9,
          ...c,
        }))
      : [
          { name: 'MD5', hashcatMode: 0, category: 'Raw Hash', confidence: 0.95 },
          { name: 'NTLM', hashcatMode: 1000, category: 'OS', confidence: 0.75 },
        ],
  }
}

// --- Results fixtures ---

// Wire shape derived from the canonical shared schema per AGENTS.md.
// Importing the type here means fixture drift surfaces at compile time
// rather than at runtime via test failures on a schema-strict route.
type MockCrackedResult = CrackedResultRow

interface MockResultsResponseOptions {
  count?: number
  results?: Array<Partial<MockCrackedResult>>
  total?: number
  limit?: number
  offset?: number
}

export function mockResultsResponse(options: MockResultsResponseOptions = {}) {
  const count = options.count ?? 3
  const results: MockCrackedResult[] = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    hashValue: `hash_${i + 1}_abcdef1234567890`,
    plaintext: `password${i + 1}`,
    crackedAt: new Date().toISOString(),
    hashListId: 1,
    hashListName: 'Main Hash List',
    campaignId: 1,
    campaignName: 'NTLM Campaign',
    attackId: 1,
    attackMode: 0,
    attackModeName: 'Dictionary' as const,
    agentId: 1,
    ...options.results?.[i],
  }))
  return {
    results,
    total: options.total ?? results.length,
    limit: options.limit ?? 50,
    offset: options.offset ?? 0,
  }
}
