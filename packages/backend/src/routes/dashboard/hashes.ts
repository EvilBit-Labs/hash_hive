import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { requireSession } from '../../middleware/auth.js'
import { DASHBOARD_RESPONSE_REFS, sharedResponse } from '../../openapi/components.js'
import { guessHashType } from '../../services/hash-analysis.js'

const hashRoutes = new OpenAPIHono<AppEnv>()

hashRoutes.use('*', requireSession)

// ─── POST /guess-type — identify hash type candidates ───────────────

const guessTypeRequestSchema = z
  .object({
    hashValue: z.string().min(1).max(1024),
  })
  .openapi('HashGuessTypeRequest')

const guessTypeResponseSchema = z
  .object({
    hashValue: z.string(),
    candidates: z.array(z.unknown()),
    identified: z.boolean(),
  })
  .openapi('HashGuessTypeResponse')

const guessTypeRoute = createRoute({
  method: 'post',
  path: '/guess-type',
  tags: ['Hashes'],
  summary: 'Identify candidate hash types for a hash value',
  security: [{ SessionCookie: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: guessTypeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Candidate hash types for the supplied value.',
      content: { 'application/json': { schema: guessTypeResponseSchema } },
    },
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  },
})

hashRoutes.openapi(guessTypeRoute, async (c) => {
  const { hashValue } = c.req.valid('json')
  const candidates = guessHashType(hashValue)

  return c.json(
    {
      hashValue,
      candidates,
      identified: candidates.length > 0,
    },
    200
  )
})

export { hashRoutes }
