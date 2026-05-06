/**
 * Shared helpers used by every Control API sub-router. Keeps each route
 * file focused on the resource-specific shape rather than re-deriving the
 * same project-scoping and id-parsing logic.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import { mapZodError, problemResponse } from '../../lib/problem-details.js';
import type { AppEnv } from '../../types.js';

/** Throwable that maps cleanly to a problem-details response. */
export class ControlApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code:
      | 'validation'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'project_not_selected'
      | 'unprocessable',
    message: string
  ) {
    super(message);
    this.name = 'ControlApiError';
  }
}

/**
 * Resolve the active project id from the X-Project-Id header (set on
 * `currentUser` by `requireApiKey`). Throws `project_not_selected` when
 * absent so the caller can surface a uniform RFC 9457 envelope.
 */
export function requireProjectId(c: Context<AppEnv>): number {
  const projectId = c.get('currentUser').projectId;
  if (!projectId) {
    throw new ControlApiError(
      400,
      'project_not_selected',
      'No project selected — include X-Project-Id header'
    );
  }
  return projectId;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export function parseIdParam(value: string | undefined): number {
  const parsed = idParamSchema.safeParse({ id: value });
  if (!parsed.success) {
    throw new ControlApiError(400, 'validation', 'id must be a positive integer');
  }
  return parsed.data.id;
}

/**
 * Centralized error → response mapping so every route handler can `throw`
 * a typed error and get the right RFC 9457 envelope without repeating
 * the boilerplate.
 */
export function controlErrorResponse(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof ControlApiError) {
    return problemResponse(c, err.status, err.code, err.message);
  }
  if (err instanceof z.ZodError) {
    return problemResponse(c, 400, 'validation', 'Invalid request', mapZodError(err));
  }
  return problemResponse(
    c,
    500,
    'internal',
    err instanceof Error ? err.message : 'Internal server error'
  );
}
