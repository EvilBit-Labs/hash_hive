/**
 * JIT provisioning, account linking, and role re-sync for AD/LDAP directory
 * logins (U4). Implements R7 (role re-sync), R8 (JIT provisioning), R9
 * (stable identity via the directory username), and R11 (email-collision
 * fail-closed); audits per R23.
 *
 * `resolveDirectoryUser` is the single entry point. It always resolves in
 * one of four ways, inside a single transaction:
 *
 *   1. An existing `ba_accounts` row (`providerId: 'ldap'`, `accountId:
 *      username`) already links this directory identity to a HashHive
 *      user -- re-sync that user's global roles from the resolved role and
 *      return it (R7). The stable `accountId` guarantees the same directory
 *      user always resolves to the same HashHive account (R9), even across
 *      a later directory email change.
 *   2. No `ldap` account yet, the derived email matches an existing
 *      HashHive user with NO local-password (`credential` `ba_accounts`)
 *      row, AND that user has no `ldap` `ba_accounts` row for a DIFFERENT
 *      directory username either -- link a new `ldap` account to that user
 *      and re-sync roles through the same guarded path as (1). This is the
 *      intended passwordless-relink case (e.g. a directory user's email
 *      attribute changed since JIT provisioning).
 *   3. No `ldap` account yet, and the derived email matches an existing
 *      user that EITHER has a local-password row OR already has an `ldap`
 *      row linking a DIFFERENT directory username -- deny (R11): write a
 *      pending `ldap_link_requests` row for admin reconciliation (U7,
 *      R12) and return a typed collision outcome. The existing user is
 *      never mutated. The second condition closes an identity/privilege
 *      hijack: without it, a second directory identity whose derived email
 *      happens to collide with an already-linked directory-only account
 *      would auto-link onto (and re-sync roles for) that unrelated
 *      account, rather than the two distinct directory identities being
 *      surfaced for admin reconciliation like every other email collision.
 *   4. No `ldap` account and no email match at all -- JIT-provision a new
 *      user (`roles: [role]`, `emailVerified: true`, `passwordHash: null`)
 *      plus its `ldap` account row (R8).
 *
 * Role re-sync (branches 1 and 2) always routes through
 * `assertLocalAdminRemains` (U6a) before writing a role change that would
 * remove the global `admin` role from an account that currently holds it
 * -- a directory promotion/demotion can never silently drop HashHive below
 * one local admin. The guard's `LocalAdminFloorError` is a typed domain
 * error (never a generic 500) and is allowed to propagate out of this
 * function uncaught; callers (U5's sign-in endpoint) map it to a 4xx, same
 * as every other guarded mutation path in this codebase.
 *
 * A concurrent first login for the same directory username (branch 4
 * firing twice before either commits) is handled defensively: the
 * `ba_accounts` unique index on `(provider_id, account_id)` (R9) makes the
 * loser's insert fail with a Postgres unique violation. `resolveDirectoryUser`
 * catches that specific error and retries once as a fresh resolution, which
 * this time finds the winner's `ldap` account and takes the re-sync branch
 * -- both callers converge on the same HashHive user, and the loser's
 * `db.transaction` rolls back cleanly (no orphaned `users` row).
 *
 * Never logs the directory password or bind secret -- nothing on this path
 * ever touches either value; only the username, derived email, and
 * resolved role travel through `recordAuditEvent`.
 */

import { type UserRole, baAccounts, ldapLinkRequests, users } from '@hashhive/shared'
import { and, eq, isNotNull } from 'drizzle-orm'

import { db } from '../db/index.js'
import { isUniqueViolation } from '../db/unique-violation.js'
import { coerceRoles } from '../middleware/auth.js'
import { type AuditActor, recordAuditEvent } from './audit-log.js'
import { assertLocalAdminRemains } from './local-admin-guard.js'

/** Drizzle transaction handle — mirrors local-admin-guard.ts's `Tx` alias. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

type UserRow = typeof users.$inferSelect

/**
 * Directory-auth events are automated (triggered by the login itself, not
 * by an authenticated HashHive admin acting on someone else's behalf), so
 * they are recorded as system actions rather than attributed to a user
 * actor that does not yet exist (JIT provisioning) or is not the one
 * performing the write (role re-sync, collision).
 */
const SYSTEM_ACTOR: AuditActor = { actorType: 'system', actorId: null }

export interface ResolveDirectoryUserInput {
  /** Stable directory username -- becomes ba_accounts.accountId (R9). */
  username: string
  /** Derived HashHive email (U3 deriveEmail), R10/R11. */
  email: string
  /**
   * Resolved global role (U3 resolveRole), R6. Callers MUST deny access
   * before calling this function when resolveRole returned null -- this
   * function always admits and assigns exactly the given role.
   */
  role: UserRole
}

/** The HashHive user a directory login resolved to, safe to build a session from. */
export interface ResolvedDirectoryUser {
  id: number
  email: string
  name: string
  roles: UserRole[]
}

export type ResolveDirectoryUserResult =
  | { ok: true; user: ResolvedDirectoryUser }
  | { ok: false; reason: 'collision'; linkRequestId: number }

function toResolvedUser(user: UserRow): ResolvedDirectoryUser {
  // coerceRoles narrows the raw text[] column to the strict UserRole union
  // (mirrors middleware/auth.ts / middleware/api-key.ts) rather than an
  // unchecked cast, so corrupted role data is dropped and logged instead
  // of silently reaching the caller.
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles: coerceRoles(user.roles, user.id),
  }
}

function rolesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((role, index) => role === b[index])
}

/**
 * Applies `role` to `userId`'s global `roles`, routed through
 * `assertLocalAdminRemains` whenever the change would remove `admin` from
 * an account that currently holds it. No-ops (and emits no audit row) when
 * the resolved role already matches the account's current roles.
 */
async function resyncRoles(tx: Tx, userId: number, role: UserRole): Promise<ResolvedDirectoryUser> {
  const [existingUser] = await tx.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!existingUser) {
    throw new Error(`ldap-provisioning: ba_accounts references missing user ${userId}`)
  }

  const newRoles: UserRole[] = [role]
  if (rolesEqual(existingUser.roles, newRoles)) {
    return toResolvedUser(existingUser)
  }

  const isDemotionFromAdmin = existingUser.roles.includes('admin') && role !== 'admin'
  if (isDemotionFromAdmin) {
    // Only a user who currently counts as a local admin per KTD3 (a
    // `credential` ba_accounts row with a non-null password, alongside the
    // `admin` role) can affect the local-admin floor -- a purely
    // directory-provisioned admin (ldap account only, no credential row)
    // never counted toward it. Gate the guard call on that so a directory
    // demotion of a directory-only admin is never spuriously rejected just
    // because no *other* local admin happens to exist right now.
    const [credentialRow] = await tx
      .select({ id: baAccounts.id })
      .from(baAccounts)
      .where(
        and(
          eq(baAccounts.userId, userId),
          eq(baAccounts.providerId, 'credential'),
          isNotNull(baAccounts.password)
        )
      )
      .limit(1)

    if (credentialRow) {
      // Throws LocalAdminFloorError (a typed domain error) if this account
      // is the sole local admin. Propagates uncaught -- see module doc.
      await assertLocalAdminRemains(tx, { kind: 'demote', userId })
    }
  }

  const [updated] = await tx
    .update(users)
    .set({ roles: newRoles, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning()

  if (!updated) {
    throw new Error(`ldap-provisioning: failed to re-sync roles for user ${userId}`)
  }

  await recordAuditEvent(
    {
      actor: SYSTEM_ACTOR,
      projectId: null,
      entityType: 'user',
      entityId: userId,
      action: 'ldap.role_synced',
      oldRow: { roles: existingUser.roles },
      newRow: { roles: updated.roles },
    },
    tx
  )

  return toResolvedUser(updated)
}

/** Branch 4: JIT-provision a brand-new user (R8) plus its `ldap` account row. */
async function provisionUser(
  tx: Tx,
  input: ResolveDirectoryUserInput
): Promise<ResolvedDirectoryUser> {
  const [user] = await tx
    .insert(users)
    .values({
      email: input.email,
      passwordHash: null,
      // No display-name attribute is passed into this function; the
      // directory username is the only stable identifier available at
      // this layer, so it doubles as the initial display name.
      name: input.username,
      emailVerified: true,
      roles: [input.role],
    })
    .returning()

  if (!user) {
    throw new Error('ldap-provisioning: failed to provision directory user')
  }

  await tx.insert(baAccounts).values({
    id: crypto.randomUUID(),
    userId: user.id,
    accountId: input.username,
    providerId: 'ldap',
  })

  await recordAuditEvent(
    {
      actor: SYSTEM_ACTOR,
      projectId: null,
      entityType: 'user',
      entityId: user.id,
      action: 'ldap.provisioned',
      newRow: user as Record<string, unknown>,
    },
    tx
  )

  return toResolvedUser(user)
}

/** Branch 2: link a new `ldap` account row to an existing (passwordless) user, then re-sync roles. */
async function linkExistingUser(
  tx: Tx,
  existingUser: UserRow,
  input: ResolveDirectoryUserInput
): Promise<ResolvedDirectoryUser> {
  await tx.insert(baAccounts).values({
    id: crypto.randomUUID(),
    userId: existingUser.id,
    accountId: input.username,
    providerId: 'ldap',
  })

  return resyncRoles(tx, existingUser.id, input.role)
}

/** Branch 3: R11 collision -- write a pending reconciliation request, never mutate the existing user. */
async function denyCollision(
  tx: Tx,
  input: ResolveDirectoryUserInput,
  matchedUserId: number
): Promise<number> {
  const [linkRequest] = await tx
    .insert(ldapLinkRequests)
    .values({
      username: input.username,
      derivedEmail: input.email,
      resolvedRole: input.role,
      matchedUserId,
      status: 'pending',
    })
    .returning({ id: ldapLinkRequests.id })

  if (!linkRequest) {
    throw new Error('ldap-provisioning: failed to record collision link request')
  }

  await recordAuditEvent(
    {
      actor: SYSTEM_ACTOR,
      projectId: null,
      entityType: 'user',
      entityId: matchedUserId,
      action: 'ldap.collision',
      reason: 'directory login email collision',
    },
    tx
  )

  return linkRequest.id
}

async function resolveOnce(input: ResolveDirectoryUserInput): Promise<ResolveDirectoryUserResult> {
  return db.transaction(async (tx) => {
    const [existingLdapAccount] = await tx
      .select({ userId: baAccounts.userId })
      .from(baAccounts)
      .where(and(eq(baAccounts.providerId, 'ldap'), eq(baAccounts.accountId, input.username)))
      .limit(1)

    if (existingLdapAccount) {
      const user = await resyncRoles(tx, existingLdapAccount.userId, input.role)
      return { ok: true, user }
    }

    const [existingUserByEmail] = await tx
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1)

    if (!existingUserByEmail) {
      const user = await provisionUser(tx, input)
      return { ok: true, user }
    }

    const [credentialRow] = await tx
      .select({ id: baAccounts.id })
      .from(baAccounts)
      .where(
        and(
          eq(baAccounts.userId, existingUserByEmail.id),
          eq(baAccounts.providerId, 'credential'),
          isNotNull(baAccounts.password)
        )
      )
      .limit(1)

    // Directory-identity hijack guard (R11 extended, code review FIX 4):
    // `existingLdapAccount` above only ruled out a `ldap` row for THIS
    // `input.username`. The matched-by-email user may still already have
    // an `ldap` row for a DIFFERENT directory username (a distinct
    // directory identity) -- auto-linking a second, unrelated directory
    // identity onto that account (and re-syncing its roles from the NEW
    // login's resolved role) would be an identity/privilege hijack between
    // two distinct directory identities, not the intended
    // passwordless-relink case. Treat it exactly like the credential-row
    // collision: deny and surface it for admin reconciliation.
    const [conflictingLdapAccount] = await tx
      .select({ id: baAccounts.id })
      .from(baAccounts)
      .where(and(eq(baAccounts.userId, existingUserByEmail.id), eq(baAccounts.providerId, 'ldap')))
      .limit(1)

    if (credentialRow || conflictingLdapAccount) {
      const linkRequestId = await denyCollision(tx, input, existingUserByEmail.id)
      return { ok: false, reason: 'collision', linkRequestId }
    }

    const user = await linkExistingUser(tx, existingUserByEmail, input)
    return { ok: true, user }
  })
}

/**
 * Find-or-create the HashHive user for a successful directory login,
 * enforcing R9 identity stability and R11 collision fail-closed. See the
 * module doc for the full branch table and the concurrency retry policy.
 */
export async function resolveDirectoryUser(
  input: ResolveDirectoryUserInput
): Promise<ResolveDirectoryUserResult> {
  try {
    return await resolveOnce(input)
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err
    }
    // A concurrent first login for the same directory identity won the
    // race between our "no existing ldap account" read and our insert.
    // Re-resolve once -- this time the ldap account (or the racing
    // insert's users.email row) exists, so we converge on the winner via
    // the re-sync or collision branch instead of surfacing a raw 500 or
    // leaving an orphaned `users` row (the loser's transaction rolled
    // back atomically when the insert threw).
    return resolveOnce(input)
  }
}
