/**
 * Shared helpers used by every Control API sub-router.
 *
 * Two responsibilities:
 *
 * 1. **Project scoping with membership enforcement.**
 *    `requireProjectMembership` is the single trust gate for project-
 *    scoped Control routes — it must be called before any query that
 *    filters by `projectId`. It calls `findProjectMembership` and
 *    returns the membership row so route handlers can do role checks
 *    via `requireProjectRole`.
 *
 * 2. **Uniform error mapping.** `controlErrorResponse` translates typed
 *    errors into RFC 9457 problem-detail responses without leaking raw
 *    exception messages on the 500 path.
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { mapZodError, problemResponse } from '../../lib/problem-details.js';
import { findProjectMembership } from '../../services/auth.js';
import type { AppEnv } from '../../types.js';

type Role = 'admin' | 'contributor' | 'viewer';

/** Throwable that maps cleanly to a problem-details response. */
export class ControlApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code:
      | 'validation'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'project_not_selected',
    message: string
  ) {
    super(message);
    this.name = 'ControlApiError';
  }
}

export interface ControlMembership {
  projectId: number;
  roles: string[];
}

/**
 * Resolve the active project id and verify the caller is a member.
 *
 * Throws `project_not_selected` (400) when the header is absent and
 * `forbidden` (403) when the caller is not a project member. Returns the
 * membership so the handler can do further role checks (e.g., admin only
 * for users listing, contributor or admin for write paths).
 */
export async function requireProjectMembership(c: Context<AppEnv>): Promise<ControlMembership> {
  const user = c.get('currentUser');
  const projectId = user.projectId;
  if (!projectId) {
    throw new ControlApiError(
      400,
      'project_not_selected',
      'No project selected — include X-Project-Id header'
    );
  }
  const membership = await findProjectMembership(user.userId, projectId);
  if (!membership) {
    throw new ControlApiError(403, 'forbidden', 'Not a member of this project');
  }
  return { projectId, roles: membership.roles ?? [] };
}

/**
 * Variant of `requireProjectMembership` that also enforces a role
 * requirement. Convenience for write/admin paths that should reject
 * viewer-role members.
 */
export async function requireProjectRole(
  c: Context<AppEnv>,
  ...roles: Role[]
): Promise<ControlMembership> {
  const membership = await requireProjectMembership(c);
  const ok = membership.roles.some((r) => roles.includes(r as Role));
  if (!ok) {
    throw new ControlApiError(403, 'forbidden', `Requires one of: ${roles.join(', ')}`);
  }
  return membership;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * Parse the `id` URL param as a positive integer. Throws the underlying
 * ZodError on failure so `controlErrorResponse` can surface the
 * structured `errors[]` field — keeping the validation envelope
 * consistent with the rest of the Control API.
 */
export function parseIdParam(value: string | undefined): number {
  return idParamSchema.parse({ id: value }).id;
}

/**
 * Centralized error → response mapping. Internal errors never leak the
 * raw exception message to the client (info disclosure risk on a
 * machine-readable surface) — they get a uniform "internal error"
 * envelope while the underlying cause is logged with the request id.
 *
 * `HTTPException` thrown by Hono middleware (e.g. `zValidator`) keeps
 * its native response so framework-shaped errors aren't relabelled
 * with a 500 envelope.
 */
export function controlErrorResponse(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof ControlApiError) {
    return problemResponse(c, err.status, err.code, err.message);
  }
  if (err instanceof z.ZodError) {
    return problemResponse(c, 400, 'validation', 'Invalid request', mapZodError(err));
  }
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  // Normalize non-Error throws so the logger keeps both the original
  // type information and a usable Error shape.
  const safe = err instanceof Error ? err : new Error(typeof err === 'string' ? err : String(err));
  logger.error(
    {
      err: safe,
      errType: typeof err,
      requestId: c.get('requestId'),
      path: c.req.path,
    },
    'control api unhandled error'
  );
  return problemResponse(c, 500, 'internal', 'An unexpected error occurred');
}
