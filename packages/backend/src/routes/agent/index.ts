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
  effectiveAgentConfigSchema,
  HEARTBEAT_ERROR_CONTEXT_MAX_CHARS,
  HEARTBEAT_ERROR_MESSAGE_MAX,
  resourceCompressionEncodingSchema,
  taskResourcesResponseSchema,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { MAX_PG_INT4 } from '../../lib/pg-limits.js'
import { requireAgentToken, requireAgentTokenForHeartbeatRecovery } from '../../middleware/auth.js'
import {
  AGENT_RESPONSE_REFS,
  agentOpenApiHonoOptions,
  registerAgentResponseComponents,
  sharedAgentResponse,
} from '../../openapi/components.js'
import { registerAgentSecurity } from '../../openapi/security.js'
import { mountCachedSpec } from '../../openapi/spec-cache.js'
import { resolveEffectiveConfig, resolveEffectiveWhitelist } from '../../services/agent-config.js'
import { logAgentError, processHeartbeat, submitBenchmarks } from '../../services/agents.js'
import { downgradeIfWhitelisted } from '../../services/agents/whitelist.js'
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
import { getResourcesForTask } from '../../services/tasks/task-resources.js'
import { decodeZapCursor, ZapCursorError } from '../../services/tasks/zap-cursor.js'
import { registerEnrollRoute } from './enroll.js'
import { agentInternalError, type AgentInternalErrorCode } from './helpers.js'

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
agentRoutes.use('/config', requireAgentToken)

// ─── POST /enroll — anonymous agent enrollment (#233 / #114) ─────────
// Route definition, handler, and local schemas live in ./enroll.ts (I5).
registerEnrollRoute(agentRoutes)

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
// `services/tasks/zaps.ts`). `zaps` is the list of already-cracked hash
// values for the task's hash list. `nextCursor` is an opaque
// continuation token: the agent echoes it back as the `cursor` query
// param to fetch the next page, and it is ALWAYS present — a base64url
// string when more rows remain, and explicit `null` (never an absent
// key) when the set is exhausted, so a client terminates cleanly on
// `nextCursor === null`. This replaced the prior `hasMore: boolean`,
// which carried no cursor material forward and could not survive rows
// sharing a `crackedAt` timestamp (#182). The agent's documented
// contract — do not rename either key or generated Go clients break.
const zapResponseSchema = z
  .object({
    zaps: z.array(z.string()),
    nextCursor: z.string().nullable().openapi({
      description:
        'Opaque continuation token, or `null` at exhaustion. Pass it back verbatim as the `cursor` query param to fetch the next page; treat it as opaque (do not parse). Always present — terminate when it is `null`.',
      example: 'eyJjIjoxNzUyMDAwMDAwMDAwLCJpIjo0Mn0',
    }),
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
    // Integrity metadata (#108 U5), additive on top of the original
    // `url`/`expiresIn` pair. Hash lists carry none of these columns
    // (out of scope for #108) so `getAgentDownloadUrl` reports all
    // three as `null` for that resource type; word/rule/mask lists
    // report `null` only when the underlying column hasn't been
    // populated yet (e.g. an upload whose checksum worker hasn't run).
    // Agents that don't understand these fields can keep ignoring them
    // — nothing here changes the meaning of `url`/`expiresIn`.
    checksum: z.string().nullable(),
    size: z.number().int().nonnegative().nullable(),
    encoding: resourceCompressionEncodingSchema.nullable(),
    // Hash-list freshness ETag (#108 follow-up), additive alongside the
    // checksum/size/encoding trio above. `null` for word/rule/mask lists
    // (they cache-skip by `checksum` instead); a weak validator derived
    // from the hash list's last-crack time for `type: 'hash-lists'`. An
    // agent echoes this back as `If-None-Match` on a later fetch and gets
    // a bodyless 304 when its cached uncracked set is still current.
    etag: z.string().nullable(),
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
// surface as an opaque 500 instead of a clean 400. `MAX_PG_INT4` is
// shared from `lib/pg-limits.js` so the cursor codec and this route
// agree on one source of truth for the int4 ceiling.
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

// `cursor` is the opaque, agent-controlled continuation token from a
// prior response's `nextCursor`. It is decoded and validated HERE, at
// the request boundary, not in the service: `decodeZapCursor` throws on
// any malformed / wrong-shape / out-of-range token, and reporting that
// as a Zod issue routes it through `agentOpenApiHonoOptions.defaultHook`
// to a clean 400 `VALIDATION_ERROR`. Decoding in the service instead
// would surface a bad cursor as the route's 404 (`{ error }` path) or a
// 500 — both wrong per the contract ("malformed cursor returns 400, not
// a 500"). Absent cursor (omitted OR empty string) → `undefined` → start
// from the beginning; an empty `?cursor=` is a client serializing a
// nil/absent token, not a malformed one, so it restarts rather than 400s.
//
// `.max(MAX_ZAP_CURSOR_LEN)` bounds the raw token BEFORE base64url-decode
// + JSON.parse so a hostile agent can't force decode/parse work on a
// multi-megabyte query value — the cursor is the one variable-length input
// on this hot polling path, and a real token is well under 100 chars.
const MAX_ZAP_CURSOR_LEN = 512
const zapQuerySchema = z.object({
  cursor: z
    .string()
    .max(MAX_ZAP_CURSOR_LEN)
    .optional()
    .openapi({
      description:
        'Opaque continuation token from a prior response’s `nextCursor`. Echo it back verbatim to fetch the next page; do not parse or construct it. Omit (or send empty) to start from the beginning.',
      example: 'eyJjIjoxNzUyMDAwMDAwMDAwLCJpIjo0Mn0',
    })
    .transform((token, ctx) => {
      if (token === undefined || token === '') {
        return undefined
      }
      try {
        return decodeZapCursor(token)
      } catch (err) {
        // Only a malformed token (ZapCursorError) is a client 400. Anything
        // else thrown from the decode path is an unexpected server fault —
        // rethrow it so the route's catch logs it and returns a 500, rather
        // than silently mislabeling a server bug as agent-supplied bad input.
        if (err instanceof ZapCursorError) {
          ctx.addIssue({ code: 'custom', message: 'Invalid cursor' })
          return z.NEVER
        }
        throw err
      }
    }),
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
    // Log any errors reported by the agent, downgrading whitelisted ones.
    if (data.errors && data.errors.length > 0) {
      const whitelist = await resolveEffectiveWhitelist(agentId)
      for (const errorMessage of data.errors) {
        const raw = { severity: 'error', message: errorMessage }
        const effective = downgradeIfWhitelisted(raw, whitelist)
        await logAgentError({
          agentId,
          severity: effective.severity,
          message: effective.message,
          context: effective.context,
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
    "Returns hash values that have been cracked from the same hash list as the given task. Agents use this to build a 'zap list' so they can skip already-cracked hashes during processing. Pagination is an opaque composite cursor: pass the `cursor` from a prior response's `nextCursor` to continue; omit it to start from the beginning; stop when `nextCursor` is `null`. BREAKING CHANGE (#182): the former `since` timestamp query param was removed in favor of `cursor`/`nextCursor`, which paginate correctly even when more cracked rows share one `crackedAt` timestamp than fit in `limit` — a case `since` could not handle without skipping or replaying rows.",
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
  const { cursor, limit } = c.req.valid('query')

  try {
    const result = await getZapsForTask(taskId, agentId, projectId, { cursor, limit })

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

// ─── GET /tasks/{taskId}/resources — static resources for a task ────
//
// Closes the gap where the assigned-task payload (`GET /tasks/next`)
// carries `attackId` but no resource ids: an agent has no way to
// discover which wordlist/rulelist/masklist ids belong to its task
// without this route. Reuses `getAgentDownloadUrl` (#108 U5) via
// `getResourcesForTask` so this route and `GET
// /resources/{type}/{id}/download-url` can never disagree about a
// given resource's integrity metadata or download URL. Hash lists are
// never included — out of #108 scope.

const taskResourcesResponseSchemaOA = taskResourcesResponseSchema.openapi('TaskResourcesResponse')

const taskResourcesRoute = createRoute({
  method: 'get',
  path: '/tasks/{taskId}/resources',
  tags: ['Tasks'],
  summary:
    "Retrieve the static resources (wordlist/rulelist/masklist) referenced by a task's attack",
  description:
    "Resolves the task's attack and returns one entry per wordlist/rulelist/masklist the attack actually references, each with integrity metadata (checksum/size/encoding) and a presigned download URL. Resource slots the attack does not use are omitted. The task must be assigned to the requesting agent and scoped to the agent's project; cross-project or unassigned lookups return 404. A referenced resource that has not finished uploading (or hasn't been checksum/compression-processed) yet returns a retriable 409 rather than a partial or silently incomplete resource list.",
  security: [{ AgentBearer: [] }],
  request: { params: taskIdParamSchema },
  responses: {
    200: {
      description: "The task's referenced static resources.",
      content: { 'application/json': { schema: taskResourcesResponseSchemaOA } },
    },
    400: sharedAgentResponse(AGENT_RESPONSE_REFS.ValidationError),
    401: sharedAgentResponse(AGENT_RESPONSE_REFS.AuthError),
    404: sharedAgentResponse(AGENT_RESPONSE_REFS.NotFound),
    409: sharedAgentResponse(AGENT_RESPONSE_REFS.Conflict),
    500: sharedAgentResponse(AGENT_RESPONSE_REFS.ServerError),
  },
})

agentRoutes.openapi(taskResourcesRoute, async (c) => {
  const { agentId, projectId } = c.get('agent')
  const { taskId } = c.req.valid('param')

  try {
    const result = await getResourcesForTask(taskId, agentId, projectId)

    if ('error' in result) {
      // Also covers the permanent-missing-resource case (PR #282 review): a
      // referenced resource that doesn't exist in this task's project at
      // all (deleted, cross-project, or misconfigured). Reusing this
      // existing branch rather than a 409 means that case is never
      // retriable-looking to the agent.
      return c.json({ error: { code: 'TASK_NOT_FOUND', message: result.error } }, 404)
    }

    if ('notReady' in result) {
      // Expected, retriable, per-poll state -- debug, not warn (PR #282
      // review). The permanent-missing case above stays at warn (real
      // config problem); enqueue *failures* inside
      // enqueueResourceCompression also stay at warn (actionable).
      logger.debug(
        { agentId, projectId, taskId },
        'Task resources not ready: a referenced resource has no resolvable download yet'
      )
      const code: AgentInternalErrorCode = 'TASK_RESOURCES_NOT_READY'
      return c.json(
        {
          error: {
            code,
            message:
              'One or more resources referenced by this task have not finished uploading or processing yet. Retry shortly.',
          },
        },
        409
      )
    }

    return c.json(result, 200)
  } catch (err: unknown) {
    return agentInternalError(
      c,
      err,
      'TASK_RESOURCES_ERROR',
      'Failed to resolve task resources',
      { agentId, taskId },
      'Task resource resolution failed'
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
    const whitelist = await resolveEffectiveWhitelist(agentId)
    const effective = downgradeIfWhitelisted(data, whitelist)
    await logAgentError({ ...effective, agentId })
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
    'Returns a short-lived presigned URL the agent uses to fetch a resource (hash list, wordlist, rule list, mask list) from object storage. The resource must belong to a project the agent is a member of; cross-project lookups return 404. For hash lists, send `If-None-Match` with the etag from a prior response to get a bodyless 304 when the uncracked set has not changed since.',
  security: [{ AgentBearer: [] }],
  request: { params: resourceParamSchema },
  responses: {
    200: {
      description: 'Presigned download URL.',
      content: { 'application/json': { schema: downloadUrlResponseSchema } },
    },
    304: {
      description:
        'Hash list unchanged since If-None-Match: no new cracks since that etag was issued. Empty body.',
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

    // Hash-list freshness ETag (#108 follow-up). `result.etag` is only ever
    // non-null for hash lists (see AgentDownloadUrlResult), so a wordlist/
    // rulelist/masklist request can never satisfy this comparison and always
    // falls through to the unchanged 200 response below.
    //
    // Exact-match contract (PR #282 review): this is a deliberate raw string
    // `===` comparison, not a full RFC 7232 weak-comparison implementation.
    // The agent always echoes the etag it was given back verbatim, so there
    // is no comma-separated etag list, no `*` wildcard, and no need to strip
    // a `W/` prefix before comparing — `result.etag` already carries it.
    const ifNoneMatch = c.req.header('if-none-match')
    if (result.etag && ifNoneMatch === result.etag) {
      return c.body(null, 304)
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

// ─── GET /config — effective tuning + hardware config ───────────────
//
// Returns the authenticated agent's resolved tuning and hardware knobs
// (per-rig override → fleet default → engine default). The error
// whitelist is evaluated server-side and is intentionally excluded (R13).
// Scope is pinned to the token's own agentId — the handler never reads
// another agent's config.

const effectiveAgentConfigSchemaOA = effectiveAgentConfigSchema.openapi('EffectiveAgentConfig')

const agentConfigRoute = createRoute({
  method: 'get',
  path: '/config',
  tags: ['Configuration'],
  summary: "Retrieve the authenticated agent's effective tuning and hardware config",
  security: [{ AgentBearer: [] }],
  responses: {
    200: {
      description:
        'Effective tuning and hardware configuration for the agent. Resolved as: per-rig override → fleet default → engine default (omitted).',
      content: { 'application/json': { schema: effectiveAgentConfigSchemaOA } },
    },
    401: sharedAgentResponse(AGENT_RESPONSE_REFS.AuthError),
    500: sharedAgentResponse(AGENT_RESPONSE_REFS.ServerError),
  },
})

agentRoutes.openapi(agentConfigRoute, async (c) => {
  const { agentId } = c.get('agent')
  try {
    const config = await resolveEffectiveConfig(agentId)
    return c.json(effectiveAgentConfigSchema.parse(config), 200)
  } catch (err: unknown) {
    return agentInternalError(
      c,
      err,
      'CONFIG_FETCH_ERROR',
      'Failed to retrieve agent configuration',
      { agentId },
      'Agent config fetch failed'
    )
  }
})

export { agentRoutes }
