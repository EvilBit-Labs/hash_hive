/**
 * Break-glass invariant guard (U6a).
 *
 * Guarantees the system always retains at least one "local admin" — a user
 * whose `users.roles` array contains the global `admin` role AND who has a
 * local password, per the authoritative KTD3 definition: a `ba_accounts` row
 * for that user with `providerId = 'credential'` AND `password IS NOT NULL`.
 *
 * `users.passwordHash` is NOT consulted — it is being deprecated/made
 * nullable (U4) and is not authoritative. A directory-provisioned user
 * (an `ldap` provider row, no `credential` row) never counts toward the
 * floor, even if `roles` includes `admin`.
 *
 * Callers (U4's role re-sync, U7's reconciliation, and any future user
 * mutation path) invoke `assertLocalAdminRemains` inside their own
 * transaction BEFORE applying a demotion, deletion, or local-password
 * clear, so the check and the mutation are atomic.
 */

import { baAccounts, users } from '@hashhive/shared'
import { and, eq, isNotNull } from 'drizzle-orm'

import type { db } from '../db/index.js'

/** Drizzle transaction handle — the callback argument type of `db.transaction`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * A mutation that could remove `userId` from the local-admin floor count.
 * All three kinds have the same effect on the guard's count: the user
 * stops counting as a local admin. The discriminated union exists so call
 * sites (and the typed error) document *why* the check ran.
 */
export type LocalAdminMutation =
  | { kind: 'demote'; userId: number }
  | { kind: 'delete'; userId: number }
  | { kind: 'clear_password'; userId: number }

/**
 * Thrown when a mutation would leave zero accounts holding both a local
 * password and the global `admin` role. Callers map this to a 4xx
 * response — never let it surface as a generic 500.
 */
export class LocalAdminFloorError extends Error {
  constructor(public readonly mutation: LocalAdminMutation) {
    super(
      `Refusing to ${mutation.kind} user ${mutation.userId}: this would leave zero local admins`
    )
    this.name = 'LocalAdminFloorError'
  }
}

/**
 * Query the current set of local-admin user ids inside `tx`, per the
 * KTD3 definition (credential `ba_accounts` row with a non-null password,
 * joined to a `users` row whose `roles` array contains `admin`).
 */
async function getLocalAdminUserIds(tx: Tx): Promise<Set<number>> {
  const rows = await tx
    .select({ userId: users.id, roles: users.roles })
    .from(users)
    .innerJoin(
      baAccounts,
      and(eq(baAccounts.userId, users.id), eq(baAccounts.providerId, 'credential'))
    )
    .where(isNotNull(baAccounts.password))

  const localAdminIds = rows.filter((row) => row.roles.includes('admin')).map((row) => row.userId)
  return new Set(localAdminIds)
}

/**
 * Assert that applying `mutation` would not drop the local-admin count to
 * zero. Resolves normally when at least one local admin remains after the
 * simulated mutation; throws {@link LocalAdminFloorError} otherwise.
 *
 * `tx` must be the caller's own transaction handle so the check and the
 * subsequent write are atomic — no concurrent mutation can slip in between
 * the read here and the caller's write.
 */
export async function assertLocalAdminRemains(tx: Tx, mutation: LocalAdminMutation): Promise<void> {
  const localAdminIds = await getLocalAdminUserIds(tx)
  const remainingCount = localAdminIds.has(mutation.userId)
    ? localAdminIds.size - 1
    : localAdminIds.size

  if (remainingCount < 1) {
    throw new LocalAdminFloorError(mutation)
  }
}
