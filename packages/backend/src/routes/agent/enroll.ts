/**
 * Agent enrollment route — anonymous `POST /enroll`.
 *
 * Extracted from `routes/agent/index.ts` (I5). Exposes
 * `registerEnrollRoute` so the aggregator can mount it without owning
 * the handler or its local schemas.
 *
 * Anonymous BY OMISSION: there is deliberately no auth middleware on
 * `/enroll`, and the route declares `security: []`. A brand-new agent
 * has no bearer token yet — it presents the operator-minted enrollment
 * token (`etk_<id>_<phrase>`) plus a stable, self-generated `clientId`,
 * and receives its long-lived bearer token (`agt_<id>_<random>`) exactly
 * once. The route never trusts the token's embedded id beyond routing —
 * `claimEnrollmentToken` bcrypt-verifies the secret.
 *
 * NOTE: this endpoint is intentionally NOT rate-limited. Abuse is already
 * bounded by the cheap-reject path (unknown id -> no row -> no bcrypt) and
 * the atomic per-token usage cap, and per-request throttling would work
 * against the batch-enrollment case reusable tokens exist for (many rigs
 * behind one NAT'd egress IP). If backpressure is ever needed, the
 * intended shape is an OPTIONAL slow-down hint on the response (a header
 * telling the agent to pace its submissions), not a request limiter.
 */

import { enrollAgentRequestSchema, enrollAgentResponseSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { parseEnrollmentToken } from '../../lib/enrollment-token.js'
import { AGENT_RESPONSE_REFS, sharedAgentResponse } from '../../openapi/components.js'
import {
  ConcurrentEnrollmentError,
  claimEnrollmentToken,
} from '../../services/enrollment-tokens.js'
import { agentInternalError } from './helpers.js'

// ─── Local schemas ───────────────────────────────────────────────────

const enrollGoneSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi('AgentEnrollmentGone')

const enrollRetrySchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi('AgentEnrollmentRetry')

const enrollTooLargeSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi('AgentEnrollmentTooLarge')

// ─── Route definition ────────────────────────────────────────────────

const enrollRoute = createRoute({
  method: 'post',
  path: '/enroll',
  tags: ['Monitoring'],
  summary: 'Enroll a new agent with an enrollment token; returns a bearer token',
  description:
    'Anonymous. The agent presents an operator-minted enrollment token and a stable clientId, and receives its long-lived bearer token exactly once. Idempotent on clientId: a retried call (e.g. after a dropped response) re-issues a bearer for the same agent rather than creating a duplicate. Response carries `Cache-Control: no-store`. A 409 means a concurrent enrollment race — the agent should retry the same request.',
  security: [],
  middleware: [
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => {
        c.header('Cache-Control', 'no-store')
        return c.json(
          { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Enrollment request body too large' } },
          413
        )
      },
    }),
  ] as const,
  request: {
    body: { content: { 'application/json': { schema: enrollAgentRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Agent enrolled. Body carries the bearer token exactly once.',
      content: { 'application/json': { schema: enrollAgentResponseSchema } },
    },
    400: sharedAgentResponse(AGENT_RESPONSE_REFS.ValidationError),
    401: sharedAgentResponse(AGENT_RESPONSE_REFS.AuthError),
    409: {
      description: 'Concurrent enrollment in progress; retry.',
      content: { 'application/json': { schema: enrollRetrySchema } },
    },
    410: {
      description: 'Enrollment token has expired or has no remaining uses.',
      content: { 'application/json': { schema: enrollGoneSchema } },
    },
    413: {
      description: 'Request body exceeds the 16 KiB enrollment cap.',
      content: { 'application/json': { schema: enrollTooLargeSchema } },
    },
    500: sharedAgentResponse(AGENT_RESPONSE_REFS.ServerError),
  },
})

// ─── Handler + registration ──────────────────────────────────────────

/**
 * Register the anonymous `POST /enroll` route on the supplied router.
 * Call this once from `routes/agent/index.ts` at the point where the
 * inline block previously lived.
 */
export function registerEnrollRoute(agentRoutes: OpenAPIHono<AppEnv>): void {
  agentRoutes.openapi(enrollRoute, async (c) => {
    const data = c.req.valid('json')

    // Derive the token id for audit logs — pure parse, no bcrypt, no secret.
    const tokenId = parseEnrollmentToken(data.token)?.tokenId ?? null

    try {
      const result = await claimEnrollmentToken({
        rawToken: data.token,
        clientId: data.clientId,
        name: data.name,
        capabilities: data.capabilities,
        hardwareProfile: data.hardwareProfile,
      })

      // The bearer token (or the reason it was withheld) must never be
      // cached by a proxy or stored in agent-side HTTP caches.
      c.header('Cache-Control', 'no-store')

      if (!result.ok) {
        // Unknown id / bad secret / revoked all collapse to a single 401 so
        // the response does not leak which tokens exist.
        if (result.reason === 'invalid') {
          logger.warn(
            { tokenId, clientId: data.clientId, reason: result.reason },
            'Agent enrollment rejected'
          )
          return c.json(
            {
              error: {
                code: 'ENROLLMENT_REJECTED',
                message: 'Invalid or revoked enrollment token',
              },
            },
            401
          )
        }
        // Expired vs exhausted: the token was valid but is no longer usable
        // (410 Gone).
        const expired = result.reason === 'expired'
        logger.warn(
          { tokenId, clientId: data.clientId, reason: result.reason },
          'Agent enrollment rejected'
        )
        return c.json(
          {
            error: {
              code: expired ? 'ENROLLMENT_EXPIRED' : 'ENROLLMENT_EXHAUSTED',
              message: expired
                ? 'Enrollment token has expired'
                : 'Enrollment token has no remaining uses',
            },
          },
          410
        )
      }

      logger.info({ tokenId, clientId: data.clientId, agentId: result.agentId }, 'Agent enrolled')
      return c.json({ agentId: result.agentId, token: result.token }, 201)
    } catch (err: unknown) {
      c.header('Cache-Control', 'no-store')
      if (err instanceof ConcurrentEnrollmentError) {
        return c.json(
          {
            error: {
              code: 'ENROLLMENT_RETRY',
              message: 'Concurrent enrollment in progress; retry.',
            },
          },
          409
        )
      }
      return agentInternalError(
        c,
        err,
        'ENROLL_ERROR',
        'Failed to enroll agent',
        { clientId: data.clientId },
        'Agent enrollment failed'
      )
    }
  })
}
