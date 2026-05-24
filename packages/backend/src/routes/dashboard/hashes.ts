import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import type { AppEnv } from '../../types.js'

import { requireSession } from '../../middleware/auth.js'
import { guessHashType } from '../../services/hash-analysis.js'

const hashRoutes = new Hono<AppEnv>()

hashRoutes.use('*', requireSession)

// ─── POST /guess-type — identify hash type candidates ───────────────

const guessTypeSchema = z.object({
  hashValue: z.string().min(1).max(1024),
})

hashRoutes.post('/guess-type', zValidator('json', guessTypeSchema), async (c) => {
  const { hashValue } = c.req.valid('json')
  const candidates = guessHashType(hashValue)

  return c.json({
    hashValue,
    candidates,
    identified: candidates.length > 0,
  })
})

export { hashRoutes }
