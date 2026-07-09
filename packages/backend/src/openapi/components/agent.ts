/**
 * Agent surface OpenAPI plumbing.
 *
 * Five named responses (`Acknowledged`, `AuthError`, `ValidationError`,
 * `NotFound`, `ServerError`) point at the agent's
 * `{ error: { code, message } }` envelope (Acknowledged points at the
 * `{ acknowledged: true }` body schema instead). Names mirror the
 * pre-deletion `packages/openapi/agent-api.yaml` for codegen stability
 * across the route-as-spec cutover.
 */

import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context, Env } from 'hono'
import type { ZodError } from 'zod'

import { z } from '@hono/zod-openapi'

import type { ResponseConfig } from './shared.js'

import { guardDuplicateComponentRegistration } from './shared.js'

/**
 * Agent error envelope. Mirrors what every agent route returns on a
 * failure: `{ error: { code, message } }`. Distinct from the dashboard
 * envelope (which adds `timestamp?`/`requestId?`); the agent surface
 * stays narrow because the on-the-wire contract documented in the
 * pre-deletion `packages/openapi/agent-api.yaml` is two fields exactly.
 * Hashcat agents parse this envelope by `error.code` — adding fields
 * would be a soft wire change.
 */
const agentErrorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.string().describe('Machine-readable error code (e.g. HEARTBEAT_ERROR).'),
      message: z.string(),
    }),
  })
  .openapi('AgentErrorEnvelope')

const AGENT_RESPONSE_NAMES = [
  'Acknowledged',
  'AuthError',
  'ValidationError',
  'NotFound',
  'ServerError',
] as const

type AgentResponseName = (typeof AGENT_RESPONSE_NAMES)[number]

declare const __AGENT_REF_BRAND__: unique symbol
export type AgentResponseRef = `#/components/responses/${AgentResponseName}` & {
  readonly [__AGENT_REF_BRAND__]: true
}

export const AGENT_RESPONSE_REFS = Object.fromEntries(
  AGENT_RESPONSE_NAMES.map((name) => [name, `#/components/responses/${name}`] as const)
) as {
  readonly [K in AgentResponseName]: `#/components/responses/${K}` & {
    readonly [__AGENT_REF_BRAND__]: true
  }
}

const AGENT_RESPONSE_DESCRIPTIONS: Record<AgentResponseName, string> = {
  Acknowledged: 'Request acknowledged. Body is `{ acknowledged: true }`.',
  AuthError: 'Authentication failed - missing, invalid, or revoked agent bearer token.',
  ValidationError:
    "The 400-class envelope for the agent surface. Two sources reach this response: (a) request body / query / path-param shapes failed Zod schema validation (envelope `code: 'VALIDATION_ERROR'`, emitted by `agentOpenApiHonoOptions.defaultHook`), and (b) semantic task-state errors on `POST /tasks/{taskId}/report` -- the service rejecting the report because the task is not assigned to this agent or was reassigned mid-update (envelope `code: 'TASK_ERROR'`, message is the service-supplied reason). Agents should switch on `error.code` to distinguish; both share this response component because both share the agent envelope shape (`{ error: { code, message } }`) and the 400 status.",
  NotFound:
    "Target resource does not exist or is outside the agent's project scope. Common cases: task not assigned to this agent, resource type/id outside the agent's project membership.",
  ServerError:
    'Server-side processing failed. Each route returns its own coarse error code on the catch-all failure path (e.g. `HEARTBEAT_ERROR`, `BENCHMARK_ERROR`, `TASK_ASSIGN_ERROR`, `TASK_REPORT_ERROR`, `TASK_ZAP_ERROR`, `TASK_RESOURCES_ERROR`, `ERROR_INGEST_ERROR`, `RESOURCE_URL_ERROR`, `CRACKER_UPDATE_ERROR`, `ENROLL_ERROR`) so agents can switch on `error.code` and treat known codes specifically. The dedicated `OPENAPI_SPEC_GENERATION_FAILED` code is emitted on `GET /openapi.json` only when production-mode spec generation fails at boot; treat it as an operator-side defect, not an agent retry case.',
}

/**
 * Acknowledged response body schema (`{ acknowledged: true }`).
 * Registered so the named `Acknowledged` shared response can `$ref`
 * a named component schema rather than carrying an inline shape.
 */
const acknowledgedBodySchema = z
  .object({ acknowledged: z.literal(true) })
  .openapi('AgentAcknowledged')

/**
 * `$ref` wrapper for agent-registry responses. The brand on
 * `AgentResponseRef` prevents cross-surface `$ref` leakage at
 * compile time (a control route handing a `ControlResponseRef`
 * to this function is a type error even when the name strings
 * happen to overlap, e.g. `NotFound` / `ValidationError`).
 */
export function sharedAgentResponse(ref: AgentResponseRef): ResponseConfig {
  return { $ref: ref } as unknown as ResponseConfig
}

/**
 * Default validation hook for every agent `OpenAPIHono` router. Maps
 * Zod validation failures to the agent's `{ error: { code: 'VALIDATION_ERROR', message } }`
 * envelope so all agent routes keep the same wire shape on bad input.
 *
 * **Message contract.** Each failing issue's `path` (`['body', 'status']`,
 * `['query', 'limit']`, etc.) is `.`-joined and prefixed before the
 * issue message; issues are then `'; '`-joined into a single string.
 * Path-less issues fall back to `'body'` as the synthetic prefix so the
 * wire always carries a non-empty prefix. An empty `issues` array
 * collapses to the literal `'Invalid request body'` (rare; only
 * reachable through a `.refine` on the root that produces no issues —
 * a defensive-default branch, not a normal code path).
 *
 * Return contract is `Response | undefined`. **`undefined` MUST mean
 * "continue handler chain" — do NOT change this to `void`.** The
 * library inspects the return value: a `Response` short-circuits with
 * the validation envelope, anything not-a-Response (including `void`
 * or `null`) is treated as "fall through to the handler". A future
 * refactor that drops the early `return undefined` would silently
 * ship a 200 response with no body on every successful validation
 * across every agent route.
 *
 * **Security note.** Issue `message` strings are emitted verbatim. Any
 * Zod schema on the agent surface that uses `.refine` / `.superRefine`
 * MUST NOT interpolate server-side config / env values (e.g. internal
 * secrets, file paths) into the message — they will land in
 * client-visible 400 bodies on the agent contract.
 */
export const agentOpenApiHonoOptions = {
  defaultHook: <E extends Env>(
    result: { success: true } | { success: false; error: ZodError },
    c: Context<E>
  ): Response | undefined => {
    if (result.success) return undefined
    const issues = result.error.issues
    const message =
      issues.length === 0
        ? 'Invalid request body'
        : issues
            .map((i) => {
              const path = i.path.length > 0 ? i.path.map(String).join('.') : 'body'
              return i.message ? `${path}: ${i.message}` : path
            })
            .join('; ')
    return c.json({ error: { code: 'VALIDATION_ERROR', message } }, 400)
  },
} as const

/**
 * Register the agent shared response components against the passed-in
 * `OpenAPIHono`'s registry. Same idempotency boundary as the dashboard
 * and control registrars - duplicates throw loudly.
 */
export function registerAgentResponseComponents<E extends Env>(app: OpenAPIHono<E>): void {
  for (const name of AGENT_RESPONSE_NAMES) {
    guardDuplicateComponentRegistration(app, 'responses', name)
  }
  app.openAPIRegistry.register('AgentErrorEnvelope', agentErrorEnvelopeSchema)
  app.openAPIRegistry.register('AgentAcknowledged', acknowledgedBodySchema)

  for (const name of AGENT_RESPONSE_NAMES) {
    const schemaRef =
      name === 'Acknowledged'
        ? '#/components/schemas/AgentAcknowledged'
        : '#/components/schemas/AgentErrorEnvelope'
    app.openAPIRegistry.registerComponent('responses', name, {
      description: AGENT_RESPONSE_DESCRIPTIONS[name],
      content: {
        'application/json': { schema: { $ref: schemaRef } },
      },
    })
  }
}
