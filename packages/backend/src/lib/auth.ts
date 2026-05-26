import * as schema from '@hashhive/shared'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { getUserWithProjects } from '../services/auth.js'

export const auth = betterAuth({
  basePath: '/api/auth',
  ...(env.BETTER_AUTH_URL ? { baseURL: env.BETTER_AUTH_URL } : {}),
  secret: env.BETTER_AUTH_SECRET,

  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      users: schema.users,
      session: schema.baSessions,
      ba_accounts: schema.baAccounts,
      verification: schema.baVerifications,
    },
  }),

  emailAndPassword: {
    enabled: true,
    disableSignUp: true, // No self-registration; users created by admin/seed only
    requireEmailVerification: false, // Air-gapped: no email service available
    autoSignIn: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    password: {
      hash: async (password: string) =>
        Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 }),
      verify: async ({ hash, password }: { hash: string; password: string }) =>
        Bun.password.verify(password, hash),
    },
  },

  session: {
    expiresIn: 28800, // 8 hours
    updateAge: 3600, // Refresh every hour on activity
    // No cookieCache -- immediate session revocation is more important than
    // saving a DB lookup per request for 1-3 concurrent dashboard users.
    additionalFields: {
      // Server-managed project context. Read by the dashboard WebSocket
      // upgrade (packages/backend/src/routes/dashboard/events.ts) to scope
      // broadcasts without trusting a client-supplied query param. Set by
      // the single-project auto-select hook below or by an explicit call
      // to POST /api/v1/dashboard/projects/select.
      projectId: {
        type: 'number',
        required: false,
      },
    },
  },

  databaseHooks: {
    session: {
      create: {
        // Single-project auto-select: when a user with exactly one
        // project membership signs in, populate session.projectId so the
        // first WebSocket upgrade (and any downstream surface that ends
        // up reading it) has a project context without waiting for the
        // selector UI (#160). Multi-project users land with projectId
        // undefined and the dashboard surfaces an offline indicator
        // until they pick a project.
        before: async (session) => {
          try {
            const userId = Number(session.userId)
            if (!Number.isInteger(userId) || userId <= 0) {
              return { data: session }
            }
            const userWithProjects = await getUserWithProjects(userId)
            if (!userWithProjects || userWithProjects.projects.length !== 1) {
              return { data: session }
            }
            const projectId = userWithProjects.projects[0]?.id
            if (typeof projectId !== 'number') {
              return { data: session }
            }
            return { data: { ...session, projectId } }
          } catch (err) {
            // Never break sign-in on membership-lookup failure. Sign-in
            // succeeds without a projectId; the user can still pick one
            // explicitly via the selector UI when it ships.
            logger.warn({ err }, 'session.create.before auto-select failed')
            return { data: session }
          }
        },
      },
    },
  },

  user: {
    modelName: 'users',
  },

  account: {
    modelName: 'ba_accounts',
  },

  advanced: {
    database: {
      generateId: ({ model }) => {
        if (model === 'user') return false // Let PostgreSQL serial auto-generate
        return crypto.randomUUID()
      },
    },
    cookiePrefix: 'hh',
  },

  // In production (air-gapped Docker Compose), frontend and backend are same-origin
  // behind a reverse proxy, so no cross-origin allowance is needed. In dev, allow localhost.
  trustedOrigins: env.NODE_ENV === 'production' ? [] : ['http://localhost:3000'],
})
