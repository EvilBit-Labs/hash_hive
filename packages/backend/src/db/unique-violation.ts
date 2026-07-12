/** Narrow, unvalidated shape shared by both a raw driver error and DrizzleQueryError. */
interface MaybeCodedError {
  code?: unknown
  cause?: unknown
}

/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505). The
 * postgres-js driver throws the coded error directly, but `db.transaction`
 * / `tx.insert(...)` wrap it in a `DrizzleQueryError` whose `.code` is
 * undefined -- the real code lives on `.cause` (drizzle-orm's `errors.ts`).
 * Walks a short `.cause` chain so both the raw driver error and the wrapped
 * form are detected; using the typed code instead of substring matching
 * prevents false positives if the driver's error message format changes.
 */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < 3 && current !== null && typeof current === 'object'; depth++) {
    const candidate = current as MaybeCodedError
    if (candidate.code === '23505') {
      return true
    }
    current = candidate.cause
  }
  return false
}
