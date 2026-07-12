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
 *
 * Atomicity across CONCURRENT callers is enforced by a Postgres
 * transaction-scoped advisory lock (`pg_advisory_xact_lock`), taken as the
 * very first statement in `assertLocalAdminRemains`, before the count
 * query. Under plain READ COMMITTED, two concurrent transactions could
 * otherwise both read the same "one local admin remains" snapshot, both
 * pass the check, and both commit their demotion -- leaving zero local
 * admins despite the guard. The advisory lock serializes every call to
 * this function on one fixed key (there is exactly one local-admin floor
 * for the whole system, not one per user, so the lock is not keyed by
 * `mutation.userId`): the second concurrent caller blocks until the first
 * commits (releasing the lock) or rolls back, then re-reads the count
 * against the first caller's already-committed effect. Mirrors the
 * `pg_advisory_xact_lock` pattern in `services/tasks/preemption.ts`
 * (`PREEMPTION_LOCK_NAMESPACE`) and `services/resources/blob-lifecycle.ts`
 * (`BLOB_KEY_LOCK_NAMESPACE`) -- auto-released on commit or rollback, no
 * explicit unlock required even on throw.
 */

import { baAccounts, users } from '@hashhive/shared'
import { and, eq, isNotNull, sql } from 'drizzle-orm'

import { db } from '../db/index.js'

/** Drizzle transaction handle — the callback argument type of `db.transaction`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * First key of the two-int `pg_advisory_xact_lock(key1, key2)` call.
 * Pinned to issue #124 (AD/LDAP authentication support) so this lock
 * namespace never collides with any other advisory-lock site (e.g.
 * `tasks/preemption.ts` uses `97`, `resources/blob-lifecycle.ts` uses
 * `108`).
 */
const LOCAL_ADMIN_FLOOR_LOCK_NAMESPACE = 124

/**
 * Second key of the `pg_advisory_xact_lock` call. There is exactly one
 * local-admin floor for the whole system (not one per user or per
 * mutation kind), so every call locks the same fixed key -- serializing
 * ALL concurrent `assertLocalAdminRemains` calls against each other,
 * regardless of which user each one is mutating.
 */
const LOCAL_ADMIN_FLOOR_LOCK_KEY = 1

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
 * the read here and the caller's write. Atomicity across CONCURRENT
 * callers (not just within one transaction) is additionally enforced by a
 * `pg_advisory_xact_lock`, taken here as the first statement, before the
 * count query -- see the module doc.
 */
export async function assertLocalAdminRemains(tx: Tx, mutation: LocalAdminMutation): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${LOCAL_ADMIN_FLOOR_LOCK_NAMESPACE}, ${LOCAL_ADMIN_FLOOR_LOCK_KEY})`
  )

  const localAdminIds = await getLocalAdminUserIds(tx)
  const remainingCount = localAdminIds.has(mutation.userId)
    ? localAdminIds.size - 1
    : localAdminIds.size

  if (remainingCount < 1) {
    throw new LocalAdminFloorError(mutation)
  }
}
