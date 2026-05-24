/**
 * RFC 9457 problem-details helper for the Control API.
 *
 * Every error response from `/api/v1/control/*` flows through here so the
 * envelope is uniform and machine-parseable. The `type` field is a stable
 * URL identifier (per RFC 9457 §3.1) — it does not need to resolve to a
 * live page; consumers use it as a string key.
 */

import type { Context } from 'hono'
import type { ZodError } from 'zod'

export type ProblemCode =
  | 'validation'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'internal'
  | 'project_not_selected'
  | 'service_unavailable'

interface ProblemMeta {
  type: string
  title: string
}

const PROBLEM_REGISTRY: Record<ProblemCode, ProblemMeta> = {
  validation: {
    type: 'https://hashhive.dev/errors/validation',
    title: 'Validation failed',
  },
  auth: {
    type: 'https://hashhive.dev/errors/auth',
    title: 'Authentication required',
  },
  forbidden: {
    type: 'https://hashhive.dev/errors/forbidden',
    title: 'Forbidden',
  },
  not_found: {
    type: 'https://hashhive.dev/errors/not-found',
    title: 'Not found',
  },
  conflict: {
    type: 'https://hashhive.dev/errors/conflict',
    title: 'Conflict',
  },
  internal: {
    type: 'https://hashhive.dev/errors/internal',
    title: 'Internal error',
  },
  project_not_selected: {
    type: 'https://hashhive.dev/errors/project-not-selected',
    title: 'Project not selected',
  },
  service_unavailable: {
    type: 'https://hashhive.dev/errors/service-unavailable',
    title: 'Service unavailable',
  },
}

const FALLBACK_META: ProblemMeta = {
  type: 'about:blank',
  title: 'Error',
}

export interface ProblemFieldError {
  path: string
  code: string
  message: string
}

interface ProblemBody {
  type: string
  title: string
  status: number
  detail: string
  instance: string
  errors?: ProblemFieldError[]
}

const PROBLEM_CONTENT_TYPE = 'application/problem+json'

/**
 * Emit an RFC 9457 problem-details response. The status code is also
 * encoded in the envelope (per the RFC) so consumers don't have to read
 * both the HTTP status and the body to know what went wrong.
 */
export function problemResponse(
  c: Context,
  status: number,
  code: ProblemCode,
  detail: string,
  errors?: ProblemFieldError[]
): Response {
  const meta = PROBLEM_REGISTRY[code] ?? FALLBACK_META
  const body: ProblemBody = {
    type: meta.type,
    title: meta.title,
    status,
    detail,
    instance: c.req.path,
  }
  if (errors && errors.length > 0) body.errors = errors
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE },
  })
}

/**
 * Flatten a Zod validation error into the RFC9457 `errors[]` shape. Path
 * segments are dot-joined for readability (`user.email` rather than
 * `["user", "email"]`).
 */
export function mapZodError(err: ZodError): ProblemFieldError[] {
  return err.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
  }))
}
