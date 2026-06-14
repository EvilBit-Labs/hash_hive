/**
 * Agent API surface aggregator — `/api/v1/agent/*`.
 *
 * Token-authenticated REST API for the Go-based hashcat agent. The
 * route IS the OpenAPI spec — `@hono/zod-openapi`'s `createRoute(...)`
 * binds the agent's Zod schemas to paths, status codes, and the
 * `AgentBearer` security scheme, with the runtime spec served at
 * `/api/v1/agent/openapi.json`.
 *
 * Wire contract invariants (must not drift):
 *
 *  - Every failure path returns the agent envelope `{ error: { code, message } }`
 *    at HTTP 400 / 401 / 404 / 500. Distinct from the dashboard envelope
 *    (which adds `timestamp?` / `requestId?`) and the control surface's
 *    RFC 9457 problem-details body. The hashcat agent project switches
 *    on `error.code` and would break on any envelope change.
 *  - `/heartbeat` uses `requireAgentTokenForHeartbeatRecovery` so an
 *    agent forced into `status='error'` by a prior fatal heartbeat can
 *    post a recovery heartbeat to return to service. Every other route
 *    uses the strict `requireAgentToken` middleware.
 *  - The `/openapi.json` endpoint is mounted BEFORE any auth middleware
 *    so it remains anonymously fetchable for client codegen tooling.
 *  - `HeartbeatResponse.hasHighPriorityTasks` is OMITTED (not `false`)
 *    when no high-priority work is available — agents must treat
 *    absence as "no priority signal" rather than receive an explicit
 *    negative. The schema's `z.literal(true).optional()` shape pins
 *    this at compile time.
 */

import type { AgentHeartbeatResponse } from '@hashhive/shared'

import {
  agentHeartbeatResponseSchema,
  agentHeartbeatSchema,
  assignedTaskSchema,
  benchmarkSubmissionSchema,
  crackerCheckUpdateRequestSchema,
  crackerCheckUpdateResponseSchema,
  HEARTBEAT_ERROR_CONTEXT_MAX_CHARS,
  HEARTBEAT_ERROR_MESSAGE_MAX,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { requireAgentToken, requireAgentTokenForHeartbeatRecovery } from '../../middleware/auth.js'
import {
  AGENT_RESPONSE_REFS,
  agentOpenApiHonoOptions,
  registerAgentResponseComponents,
  sharedAgentResponse,
} from '../../openapi/components.js'
import { registerAgentSecurity } from '../../openapi/security.js'
import { mountCachedSpec } from '../../openapi/spec-cache.js'
import { logAgentError, processHeartbeat, submitBenchmarks } from '../../services/agents.js'
import {
  compareCrackerVersions,
  getCrackerDownloadUrl,
  getLatestCracker,
  isKnownEngine,
  normalizeEngineName,
} from '../../services/crackers.js'
import { getAgentDownloadUrl } from '../../services/resources.js'
import {
  assignNextTask,
  getZapsForTask,
  handleTaskFailure,
  updateTaskProgress,
} from '../../services/tasks.js'
import { getStopTaskIdsForAgent } from '../../services/tasks/preemption.js'
import { agentInternalError } from './helpers.js'

const agentRoutes = new OpenAPIHono<AppEnv>(agentOpenApiHonoOptions)

// ─── OpenAPI plumbing ───────────────────────────────────────────────
//
// Security scheme + shared response components register against this
// instance's registry. Both registrars throw on duplicate registration,
// which is the intended fail-fast posture (HMR reloads the module
// fresh in dev; production boots once).

registerAgentSecurity(agentRoutes)
registerAgentResponseComponents(agentRoutes)

// Spec endpoint goes on FIRST so the per-path auth middleware never
// gates it. Anonymous fetch is the contract for client codegen and the
// (planned) hashcat agent project's regen step. The default failure
// envelope is the dashboard shape; for the agent surface we pass a
// surface-specific envelope so a spec-generation 500 matches the
// documented agent error contract instead of leaking the dashboard
// envelope into agent client SDKs.
mountCachedSpec(
  agentRoutes,
  '/openapi.json',
  {
    openapi: '3.1.0',
    info: {
      title: 'HashHive Agent API',
      version: '2.0.0',
      description:
        'Token-authenticated REST API for Go-based hashcat agents. Authenticated by per-agent pre-shared bearer tokens (`Authorization: Bearer <token>`). Errors use the agent envelope (`{ error: { code, message } }`); distinct from the dashboard and control surfaces.',
    },
  },
  {
    generatorOpts: { unionPreferredType: 'oneOf' },
    failureEnvelope: {
      body: JSON.stringify({
        error: {
          code: 'OPENAPI_SPEC_GENERATION_FAILED',
          message:
            'The OpenAPI spec for the agent surface could not be generated. This indicates a backend route definition is malformed; check the backend logs for the underlying error.',
        },
      }),
      contentType: 'application/json; charset=utf-8',
    },
  }
)

// ─── Authenticated path middleware ──────────────────────────────────
//
// `/heartbeat` uses the recovery-friendly variant so an agent whose row
// is in status='error' (set by a prior fatal-error heartbeat) can post
// a clean heartbeat to announce it's healthy again. processHeartbeat
// transitions the agent back to 'online'. Every other agent endpoint
// uses the strict variant — a broken agent must not pick up new work
// until it has recovered via /heartbeat first.

agentRoutes.use('/heartbeat', requireAgentTokenForHeartbeatRecovery)
agentRoutes.use('/tasks/*', requireAgentToken)
agentRoutes.use('/errors', requireAgentToken)
agentRoutes.use('/benchmark', requireAgentToken)
agentRoutes.use('/resources/*', requireAgentToken)
agentRoutes.use('/cracker/*', requireAgentToken)

// ─── Local schema annotations ───────────────────────────────────────
//
// Annotate shared schemas with `.openapi('Name')` locally so the
// generated spec carries stable component names matching the
// pre-deletion `agent-api.yaml`. Schemas declared in this file are also
// annotated where they appear in a response or request body so the
// generated spec stays self-documenting.

const heartbeatRequestSchema = agentHeartbeatSchema.openapi('Heartbeat')
const heartbeatResponseSchemaOA = agentHeartbeatResponseSchema.openapi('HeartbeatResponse')
const benchmarkSubmissionSchemaOA = benchmarkSubmissionSchema.openapi('BenchmarkSubmission')
const crackerCheckUpdateRequestSchemaOA = crackerCheckUpdateRequestSchema.openapi(
  'CrackerCheckUpdateRequest'
)
const crackerCheckUpdateResponseSchemaOA = crackerCheckUpdateResponseSchema.openapi(
  'CrackerCheckUpdateResponse'
)
const taskDescriptorSchema = assignedTaskSchema.openapi('TaskDescriptor')

const taskNextResponseSchema = z
  .object({
    task: taskDescriptorSchema.nullable(),
  })
  .openapi('TaskNextResponse')

const taskReportRequestSchema = z
  .object({
    status: z.enum(['running', 'completed', 'failed', 'exhausted']),
    progress: z
      .object({
        keyspaceProgress: z
          .union([
            z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            z
              .string()
              .regex(/^[0-9]+$/)
              .max(64),
          ])
          .optional(),
        speed: z.number().optional(),
        temperature: z.number().optional(),
      })
      .optional(),
    results: z
      .array(
        z.object({
          hashValue: z.string(),
          plaintext: z.string(),
        })
      )
      .optional(),
    errors: z.array(z.string()).optional(),
  })
  .openapi('TaskReport')

// Mirrors `getZapsForTask`'s runtime return shape (see
// `services/tasks/zaps.ts`) and the pre-deletion `agent-api.yaml`
// `ZapResponse` schema. `zaps` is the list of already-cracked hash
// values for the task's hash list; `hasMore` signals truncation beyond
// the requested `limit`. The agent's documented contract — do not
// rename either key or generated Go clients will silently drop cracked
// hashes and the agent will re-run already-cracked work.
const zapResponseSchema = z
  .object({
    zaps: z.array(z.string()),
    hasMore: z.boolean(),
  })
  .openapi('ZapResponse')

const agentErrorRequestSchema = z
  .object({
    severity: z.enum(['warning', 'error', 'fatal']),
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
    taskId: z.number().int().positive().optional(),
  })
  .openapi('AgentError')

// The base `{ acknowledged: true }` body schema lives in
// `openapi/components.ts` as `AgentAcknowledged` and is served via the
// shared `Acknowledged` response component. The local
// `taskReportResponseSchema` below is a discriminated UNION so the
// "retried appears only on failure-retry" wire contract is type-enforced
// rather than left to handler discipline:
//
//   - Bare success body: `{ acknowledged: true }` (.strict() so a future
//     handler adding `retried: false` here is a compile-time error AND
//     a runtime Zod failure — matches the disallowUnknownFields
//     posture of the hashcat agent project's strict JSON parser).
//   - Failure-retry body: `{ acknowledged: true, retried: boolean }`
//     (.strict() so `retried` is required in this branch).
//
// Only the failure-retry branch of POST /tasks/{taskId}/report surfaces
// the `retried` key; every other ack-bearing agent route uses the bare
// shared `Acknowledged` response so the agent contract stays narrow.
// `action: 'stop'` (issue #97 U4) is an additive optional field on BOTH
// arms — server-initiated only — so an agent reporting progress on a task
// that was preempted mid-flight is told to stop on the fast path (the
// heartbeat `stopTaskIds` list is the slower primary channel). Omitted when
// the task is still active, preserving the bare `{ acknowledged: true }`
// wire shape the hashcat agent's strict JSON parser depends on.
const taskReportAckSchema = z
  .object({ acknowledged: z.literal(true), action: z.literal('stop').optional() })
  .strict()
const taskReportRetryAckSchema = z
  .object({
    acknowledged: z.literal(true),
    retried: z.boolean(),
    action: z.literal('stop').optional(),
  })
  .strict()
const taskReportResponseSchema = z
  .union([taskReportAckSchema, taskReportRetryAckSchema])
  .openapi('TaskReportAcknowledged')

const downloadUrlResponseSchema = z
  .object({
    // `.url()` makes the generator emit `format: uri` (matching the
    // pre-migration YAML) so generated client codegen recognizes the
    // field as a URL rather than a free-form string. Every emit site
    // calls `getPresignedUrl` so a non-URL value would itself be a
    // service-layer bug; the schema simply locks the contract.
    url: z.url(),
    expiresIn: z.number().int().positive(),
  })
  .openapi('AgentResourceDownloadUrl')

// Param key is `taskId` (not `id`) to match the pre-deletion
// `agent-api.yaml` path templates `/tasks/{taskId}/report` and
// `/tasks/{taskId}/zaps`. Renaming would break any regenerated Go
// agent client — codegen translates path-param names directly into
// method-argument names. `z.coerce.number().int().positive()`
// rejects non-numeric, zero, and negative inputs at the validator
// boundary (replaces the old hand-rolled `Number.isNaN || taskId <= 0`
// guard). The `.max(MAX_PG_INT4)` upper bound keeps absurd inputs
// like `/tasks/1e15/report` from reaching the service layer (and the
// downstream PostgreSQL `serial` / int4 column) where they would
// surface as an opaque 500 instead of a clean 400.
const MAX_PG_INT4 = 2_147_483_647
const taskIdParamSchema = z.object({
  taskId: z.coerce.number().int().positive().max(MAX_PG_INT4).openapi({ example: 42 }),
})

// `type` is a closed vocabulary on the service side: `getAgentDownloadUrl`
// in services/resources.ts only accepts `'hash-lists' | 'wordlists' |
// 'rulelists' | 'masklists'` and silently returns null (→ route 404)
// for everything else. Encoding the enum at the validator boundary
// turns a 404 ("resource not found") into a clean 400
// VALIDATION_ERROR so generated agent clients can discover the
// supported values from the spec and so the failure mode discriminates
// between "you misspelled the type" and "the row genuinely doesn't
// exist". `id` carries the same `.max(MAX_PG_INT4)` bound as taskId
// for the same reason: keep absurd inputs from reaching the
// PostgreSQL serial column where they would surface as opaque 500s.
const resourceParamSchema = z.object({
  type: z
    .enum(['hash-lists', 'wordlists', 'rulelists', 'masklists'])
    .openapi({ example: 'wordlists' }),
  id: z.coerce.number().int().positive().max(MAX_PG_INT4).openapi({ example: 1 }),
})

const zapQuerySchema = z.object({
  since: z.iso
    .datetime()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  limit: z.coerce.number().int().min(1).max(10_000).default(10_000),
})

// ─── POST /heartbeat — agent heartbeat ──────────────────────────────

const heartbeatRoute = createRoute({
  method: 'post',
  path: '/heartbeat',
  tags: ['Monitoring'],
  summary: 'Send agent heartbeat with status and capabilities',
  security: [{ AgentBearer: [] }],
  request: {
    body: { content: { 'application/json': { schema: heartbeatRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Heartbeat accepted.',
      content: { 'application/json': { schema: heartbeatResponseSchemaOA } },
    },
    400: sharedAgentResponse(AGENT_RESPONSE_REFS.ValidationError),
    401: sharedAgentResponse(AGENT_RESPONSE_REFS.AuthError),
    500: sharedAgentResponse(AGENT_RESPONSE_REFS.ServerError),
  },
})

agentRoutes.openapi(heartbeatRoute, async (c) => {
  const { agentId } = c.get('agent')
  const data = c.req.valid('json')
  try {
    const result = await processHeartbeat(agentId, data)
    // Derive the preemption stop-signal from the DB (#97 U4). Omitted when
    // empty, mirroring the hasHighPriorityTasks omit-when-false policy.
    const stopTaskIds = await getStopTaskIdsForAgent(agentId)
    const body: AgentHeartbeatResponse = {
      acknowledged: true,
      ...(result.hasHighPriorityTasks ? { hasHighPriorityTasks: true } : {}),
      ...(stopTaskIds.length > 0 ? { stopTaskIds } : {}),
    }
    return c.json(body, 200)
  } catch (err: unknown) {
    // Heartbeat is the agent's hot-path liveness primitive. Without
    // this try/catch the throw would fall through to the global
    // `app.onError` and return the dashboard envelope, violating the
    // Agent API's `{ error: { code, message } }` contract.
    return agentInternalError(
      c,
      err,
      'HEARTBEAT_ERROR',
      'Failed to process heartbeat',
      { agentId, status: data.status, hasError: Boolean(data.error) },
      'Heartbeat processing failed'
    )
  }
})

// ─── POST /tasks/next — request next task ───────────────────────────

const tasksNextRoute = createRoute({
  method: 'post',
  path: '/tasks/next',
  tags: ['Tasks'],
  summary: 'Request the next available task matching agent capabilities',
  security: [{ AgentBearer: [] }],
  responses: {
    200: {
      description: 'Next task descriptor, or `{ task: null }` when none is available.',
      content: { 'application/json': { schema: taskNextResponseSchema } },
    },
    401: sharedAgentResponse(AGENT_RESPONSE_REFS.AuthError),
    500: sharedAgentResponse(AGENT_RESPONSE_REFS.ServerError),
  },
})

agentRoutes.openapi(tasksNextRoute, async (c) => {
  const { agentId } = c.get('agent')
  try {
    const task = await assignNextTask(agentId)
    return c.json({ task }, 200)
  } catch (err: unknown) {
    return agentInternalError(
      c,
      err,
      'TASK_ASSIGN_ERROR',
      'Failed to assign next task',
      { agentId },
      'Task assignment failed'
    )
  }
})

// ─── POST /tasks/{taskId}/report — report task progress ─────────────

const taskReportRoute = createRoute({
  method: 'post',
  path: '/tasks/{taskId}/report',
  tags: ['Tasks'],
  summary: 'Report task progress, results, and errors',
  security: [{ AgentBearer: [] }],
  request: {
    params: taskIdParamSchema,
    body: { content: { 'application/json': { schema: taskReportRequestSchema } } },
  },
  responses: {
    200: {
      // `retried` appears ONLY on the failure-retry branch. On the
      // ordinary success path the body is bare `{ acknowledged: true }`
      // (preserves the pre-U6 wire shape that the hashcat agent
      // project's strict JSON parser depends on — adding the field
      // unconditionally would break a `disallowUnknownFields` consumer).
      description:
        'Report accepted. `retried: true|false` is included only when the report transitions the task to `failed`; the non-failure success path returns the bare `{ acknowledged: true }` body.',
      content: { 'application/json': { schema: taskReportResponseSchema } },
    },
    400: sharedAgentResponse(AGENT_RESPONSE_REFS.ValidationError),
    401: sharedAgentResponse(AGENT_RESPONSE_REFS.AuthError),
    500: sharedAgentResponse(AGENT_RESPONSE_REFS.ServerError),
  },
})

agentRoutes.openapi(taskReportRoute, async (c) => {
  const { agentId } = c.get('agent')
  const { taskId } = c.req.valid('param')
  const data = c.req.valid('json')

  try {
    // Log any errors reported by the agent
    if (data.errors && data.errors.length > 0) {
      for (const errorMessage of data.errors) {
        await logAgentError({
          agentId,
          severity: 'error',
          message: errorMessage,
          taskId,
        })
      }
    }

    // Handle failure with retry logic
    if (data.status === 'failed') {
      const failResult = await handleTaskFailure(
        taskId,
        agentId,
        data.errors?.[0] ?? 'Unknown failure'
      )
      if ('error' in failResult) {
        return c.json({ error: { code: 'TASK_ERROR', message: failResult.error } }, 400)
      }
      // The task was preempted (paused) — tell the agent to stop (#97 U6).
      if ('stopped' in failResult) {
        return c.json({ acknowledged: true, action: 'stop' }, 200)
      }
      return c.json({ acknowledged: true, retried: failResult.retried ?? false }, 200)
    }

    // Update task progress and insert cracked results
    const result = await updateTaskProgress(taskId, agentId, data)

    if ('error' in result) {
      return c.json({ error: { code: 'TASK_ERROR', message: result.error } }, 400)
    }

    // The task was preempted (paused) — the progress report was a no-op and
    // the agent is told to stop on this fast path (#97 U4).
    if ('stopped' in result) {
      return c.json({ acknowledged: true, action: 'stop' }, 200)
    }

    return c.json({ acknowledged: true }, 200)
  } catch (err: unknown) {
    return agentInternalError(
      c,
      err,
      'TASK_REPORT_ERROR',
      'Failed to process task report',
      { agentId, taskId, status: data.status },
      'Task report processing failed'
    )
  }
})

// ─── GET /tasks/{taskId}/zaps — cracked hashes for a task ───────────

const zapsRoute = createRoute({
  method: 'get',
  path: '/tasks/{taskId}/zaps',
  tags: ['Tasks'],
  summary: 'Retrieve cracked hash values for a task',
  description:
    "Returns hash values that have been cracked from the same hash list as the given task. Agents use this to build a 'zap list' so they can skip already-cracked hashes during processing.",
  security: [{ AgentBearer: [] }],
  request: {
    params: taskIdParamSchema,
    query: zapQuerySchema,
  },
  responses: {
    200: {
      description: 'Cracked hash values for the task.',
      content: { 'application/json': { schema: zapResponseSchema } },
    },
    400: sharedAgentResponse(AGENT_RESPONSE_REFS.ValidationError),
    401: sharedAgentResponse(AGENT_RESPONSE_REFS.AuthError),
    404: sharedAgentResponse(AGENT_RESPONSE_REFS.NotFound),
    500: sharedAgentResponse(AGENT_RESPONSE_REFS.ServerError),
  },
})

agentRoutes.openapi(zapsRoute, async (c) => {
  const { agentId, projectId } = c.get('agent')
  const { taskId } = c.req.valid('param')
  const { since, limit } = c.req.valid('query')

  try {
    const result = await getZapsForTask(taskId, agentId, projectId, { since, limit })

    if ('error' in result) {
      return c.json({ error: { code: 'TASK_NOT_FOUND', message: result.error } }, 404)
    }

    return c.json(result, 200)
  } catch (err: unknown) {
    return agentInternalError(
      c,
      err,
      'TASK_ZAP_ERROR',
      'Failed to retrieve cracked hashes',
      { agentId, taskId },
      'Task zap lookup failed'
    )
  }
})

// ─── POST /errors — log an agent error ──────────────────────────────
//
// Same size caps as agentHeartbeatErrorSchema (in @hashhive/shared) so the
// standalone error channel can't be used to bypass the bound. severity stays
// wider (warning|error|fatal) for back-compat with agents that have not
// adopted the heartbeat-borne error block yet.

const reportErrorRoute = createRoute({
  method: 'post',
  path: '/errors',
  tags: ['Monitoring'],
  summary: 'Report an agent error',
  security: [{ AgentBearer: [] }],
  request: {
    body: { content: { 'application/json': { schema: agentErrorRequestSchema } } },
  },
  responses: {
    200: sharedAgentResponse(AGENT_RESPONSE_REFS.Acknowledged),
    400: sharedAgentResponse(AGENT_RESPONSE_REFS.ValidationError),
    401: sharedAgentResponse(AGENT_RESPONSE_REFS.AuthError),
    500: sharedAgentResponse(AGENT_RESPONSE_REFS.ServerError),
  },
})

agentRoutes.openapi(reportErrorRoute, async (c) => {
  const { agentId } = c.get('agent')
  const data = c.req.valid('json')
  try {
    await logAgentError({ ...data, agentId })
    return c.json({ acknowledged: true }, 200)
  } catch (err: unknown) {
    return agentInternalError(
      c,
      err,
      'ERROR_INGEST_ERROR',
      'Failed to record agent error',
      { agentId, severity: data.severity },
      'Agent error log ingestion failed'
    )
  }
})

// ─── POST /benchmark — submit hashcat benchmark results ─────────────

const benchmarkRoute = createRoute({
  method: 'post',
  path: '/benchmark',
  tags: ['Monitoring'],
  summary: 'Submit hashcat benchmark results for this agent',
  security: [{ AgentBearer: [] }],
  request: {
    body: { content: { 'application/json': { schema: benchmarkSubmissionSchemaOA } } },
  },
  responses: {
    200: sharedAgentResponse(AGENT_RESPONSE_REFS.Acknowledged),
    400: sharedAgentResponse(AGENT_RESPONSE_REFS.ValidationError),
    401: sharedAgentResponse(AGENT_RESPONSE_REFS.AuthError),
    500: sharedAgentResponse(AGENT_RESPONSE_REFS.ServerError),
  },
})

agentRoutes.openapi(benchmarkRoute, async (c) => {
  const { agentId } = c.get('agent')
  const data = c.req.valid('json')
  try {
    await submitBenchmarks(agentId, data.entries, data.crackerVersion)
    return c.json({ acknowledged: true }, 200)
  } catch (err: unknown) {
    return agentInternalError(
      c,
      err,
      'BENCHMARK_ERROR',
      'Failed to store benchmark results',
      { agentId, entryCount: data.entries.length },
      'Benchmark submission failed'
    )
  }
})

// ─── GET /resources/{type}/{id}/download-url — presigned download ───

const downloadUrlRoute = createRoute({
  method: 'get',
  path: '/resources/{type}/{id}/download-url',
  tags: ['Resources'],
  summary: 'Presigned download URL for a resource bound to this agent project',
  description:
    'Returns a short-lived presigned URL the agent uses to fetch a resource (hash list, wordlist, rule list, mask list) from object storage. The resource must belong to a project the agent is a member of; cross-project lookups return 404.',
  security: [{ AgentBearer: [] }],
  request: { params: resourceParamSchema },
  responses: {
    200: {
      description: 'Presigned download URL.',
      content: { 'application/json': { schema: downloadUrlResponseSchema } },
    },
    400: sharedAgentResponse(AGENT_RESPONSE_REFS.ValidationError),
    401: sharedAgentResponse(AGENT_RESPONSE_REFS.AuthError),
    404: sharedAgentResponse(AGENT_RESPONSE_REFS.NotFound),
    500: sharedAgentResponse(AGENT_RESPONSE_REFS.ServerError),
  },
})

agentRoutes.openapi(downloadUrlRoute, async (c) => {
  const { agentId, projectId } = c.get('agent')
  const { type: resourceType, id: resourceId } = c.req.valid('param')

  try {
    const result = await getAgentDownloadUrl(resourceType, resourceId, projectId)

    if (!result) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: 'Resource not found or has no file' } },
        404
      )
    }

    return c.json(result, 200)
  } catch (err: unknown) {
    return agentInternalError(
      c,
      err,
      'RESOURCE_URL_ERROR',
      'Failed to generate resource download URL',
      { agentId, resourceType, resourceId },
      'Resource download URL generation failed'
    )
  }
})

// ─── POST /cracker/check-update — agent cracker auto-update ─────────
//
// Returns the latest active cracker binary for the agent's engine +
// platform and a presigned download URL when the agent is behind.
// Missing `engine` defaults to `'hashcat'` for back-compat with agents
// that have not adopted the engines[] capability advertisement. Engine
// normalization delegates to the service-layer helper so the route and
// service can never disagree about what `'Hashcat'` means.

const crackerCheckUpdateRoute = createRoute({
  method: 'post',
  path: '/cracker/check-update',
  tags: ['Cracker'],
  summary: 'Poll for a newer cracker binary for this agent engine and platform',
  security: [{ AgentBearer: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: crackerCheckUpdateRequestSchemaOA } },
    },
  },
  responses: {
    200: {
      description: 'Update-check result. Discriminated on `updateAvailable`.',
      content: { 'application/json': { schema: crackerCheckUpdateResponseSchemaOA } },
    },
    400: sharedAgentResponse(AGENT_RESPONSE_REFS.ValidationError),
    401: sharedAgentResponse(AGENT_RESPONSE_REFS.AuthError),
    500: sharedAgentResponse(AGENT_RESPONSE_REFS.ServerError),
  },
})

agentRoutes.openapi(crackerCheckUpdateRoute, async (c) => {
  const { agentId } = c.get('agent')
  const data = c.req.valid('json')
  const engine = normalizeEngineName(data.engine)
  // Trim version + platform so an agent sending `'6.2.7 '` (trailing
  // whitespace) doesn't compare unequal against the registry's stored
  // value. The comparator treats whitespace as part of the version
  // string, so the trim has to happen here.
  const platform = data.platform.trim()
  const version = data.version.trim()

  // A misconfigured agent advertising `engine: "hashca"` would otherwise
  // poll forever and silently appear up-to-date. Log a warn so an
  // operator searching logs for "stale agent" can find it. We still
  // return `updateAvailable: false` (not 400) — the agent contract is
  // soft on engine names so unknown values don't break the update loop.
  if (!isKnownEngine(engine)) {
    logger.warn(
      { engine, rawEngine: data.engine, platform },
      'Cracker check-update from agent advertising unknown engine; treating as no update'
    )
    return c.json({ updateAvailable: false as const, engine }, 200)
  }

  try {
    const latest = await getLatestCracker({ engine, platform })

    if (!latest || compareCrackerVersions(latest.version, version) <= 0) {
      return c.json({ updateAvailable: false as const, engine }, 200)
    }

    const downloadInfo = await getCrackerDownloadUrl(latest.id)
    if (!downloadInfo) {
      // Latest record exists but lacks an uploaded file — treat as no update
      // available rather than failing the agent's poll. Logged at warn so
      // an admin can find rows that were created but never uploaded.
      logger.warn(
        // `platform` is the trimmed local binding (line above); using
        // `data.platform` here would log a possibly-whitespace-padded
        // value that operators couldn't correlate against the trimmed
        // value the unknown-engine warn emits.
        { crackerBinaryId: latest.id, engine, platform },
        'Latest cracker binary has no completed file; agent will not see this version'
      )
      return c.json({ updateAvailable: false as const, engine }, 200)
    }

    return c.json(
      {
        updateAvailable: true as const,
        engine,
        latestVersion: latest.version,
        downloadUrl: downloadInfo.url,
        expiresIn: downloadInfo.expiresIn,
      },
      200
    )
  } catch (err: unknown) {
    return agentInternalError(
      c,
      err,
      'CRACKER_UPDATE_ERROR',
      'Failed to check for cracker update',
      { agentId, engine, platform },
      'Cracker update check failed'
    )
  }
})

export { agentRoutes }
