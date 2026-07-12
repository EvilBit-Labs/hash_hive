import * as schema from '@hashhive/shared'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

import { env } from '../config/env.js'
import { getLdapConfig } from '../config/ldap.js'
import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import {
  findProjectMembership,
  getUserLastProjectId,
  getUserWithProjects,
} from '../services/auth.js'
import { ldapPlugin } from './ldap/plugin.js'
import { getTrustedOrigins } from './trusted-origins.js'

// AD/LDAP directory sign-in (U5, #124). `getLdapConfig` returns null when
// LDAP_ENABLED is false (the default) so the plugins array below is empty
// and the /sign-in/ldap endpoint is never mounted -- existing deployments
// are unaffected byte-for-byte until an operator opts in (R17).
const ldapConfig = getLdapConfig(env)

/**
 * Compute the initial `projectId` to attach to a new BetterAuth session
 * row, applying (in order):
 *
 *   1. Single-project user -> their one project (unambiguous).
 *   2. Multi-project user with a valid `last_project_id` preference
 *      AND current membership in that project -> rehydrate it.
 *   3. Otherwise -> null. The dashboard surfaces the selector UI and
 *      the WebSocket upgrade stays unattached until POST /projects/select.
 *
 * Any DB error during the lookups is logged at error level (it is an
 * operator-visible incident, not a normal multi-project sign-in) and the
 * function returns null so sign-in proceeds without a projectId.
 *
 * Extracted from `databaseHooks.session.create.before` so the branching
 * is unit-testable without standing up the full BetterAuth runtime.
 */
export async function computeInitialSessionProjectId(userId: number): Promise<number | null> {
  if (!Number.isInteger(userId) || userId <= 0) {
    // Distinct from the "multi-project pre-selector" branch below
    // which legitimately returns null. A non-integer or non-positive
    // userId here means session.userId surfaced as NaN, 0, or a
    // string -- adapter drift that should be observable, not silent.
    logger.error(
      { rawUserId: userId },
      'computeInitialSessionProjectId: invalid userId from session; sign-in proceeding without auto-select'
    )
    return null
  }

  let userWithProjects
  try {
    userWithProjects = await getUserWithProjects(userId)
  } catch (err) {
    logger.error(
      { err, userId },
      'session.create.before: project lookup failed; sign-in proceeding without auto-select'
    )
    return null
  }
  if (!userWithProjects) {
    return null
  }

  // Branch 1: single-project user -- unambiguous auto-select.
  if (userWithProjects.projects.length === 1) {
    const projectId = userWithProjects.projects[0]?.id
    if (typeof projectId === 'number') {
      return projectId
    }
  }

  // Branch 2: multi-project user -- rehydrate last_project_id when the
  // user still has membership. A revoked-membership project must NOT
  // silently reattach via the preference.
  let lastProjectId: number | null
  try {
    lastProjectId = await getUserLastProjectId(userId)
  } catch (err) {
    logger.error(
      { err, userId },
      'session.create.before: last_project_id lookup failed; sign-in proceeding without rehydrate'
    )
    return null
  }
  if (lastProjectId === null) {
    return null
  }

  let membership
  try {
    membership = await findProjectMembership(userId, lastProjectId)
  } catch (err) {
    logger.error(
      { err, userId, lastProjectId },
      'session.create.before: membership lookup for last_project_id failed; sign-in proceeding without rehydrate'
    )
    return null
  }
  if (!membership) {
    return null
  }

  return lastProjectId
}

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
        // Populate session.projectId on sign-in (single-project auto-
        // select or last_project_id rehydrate). See
        // `computeInitialSessionProjectId` for the branching rules and
        // failure semantics.
        before: async (session) => {
          const projectId = await computeInitialSessionProjectId(Number(session.userId))
          if (projectId === null) {
            return { data: session }
          }
          return { data: { ...session, projectId } }
        },
      },
    },
  },

  user: {
    modelName: 'users',
    // BetterAuth only surfaces user columns it has been told about, so
    // `users.roles` must be declared here or `session.user.roles` comes
    // back undefined -- `coerceRoles` then yields [] and every global
    // `requireRole(...)` check 403s for a legitimate admin (issue #228).
    // `input: false` keeps roles admin/seed-managed: no client-facing
    // write path (e.g. updateUser) may set them. Mirrors the
    // `session.additionalFields.projectId` declaration above.
    additionalFields: {
      roles: {
        type: 'string[]',
        required: false,
        input: false,
      },
    },
  },

  account: {
    modelName: 'ba_accounts',
  },

  // KTD2: registers POST /api/auth/sign-in/ldap only when LDAP_ENABLED.
  // See lib/ldap/plugin.ts for the plugin implementation.
  plugins: ldapConfig ? [ldapPlugin(ldapConfig)] : [],

  advanced: {
    database: {
      generateId: ({ model }) => {
        if (model === 'user') return false // Let PostgreSQL serial auto-generate
        return crypto.randomUUID()
      },
    },
    cookiePrefix: 'hh',
    // SameSite=Strict prevents the browser from attaching the session
    // cookie to cross-site requests, blocking most CSRF vectors at the
    // cookie layer. The middleware/csrf.ts same-origin check is the
    // belt-and-suspenders for historical browsers + future policy drift.
    // `secure: true` requires HTTPS in production; dev allows http://localhost.
    defaultCookieAttributes: {
      sameSite: 'strict',
      secure: env.NODE_ENV === 'production',
      httpOnly: true,
    },
  },

  // Production (air-gapped Docker Compose) serves frontend and backend
  // behind one reverse proxy, so same-origin is the invariant. Dev and
  // E2E need cross-port allowances; the shared helper is the only
  // place that parses `BETTER_AUTH_TRUSTED_ORIGINS`.
  trustedOrigins: [...getTrustedOrigins()],
})
