/**
 * Shared mocking helpers for `db` chain assertions in bun:test.
 *
 * Drizzle's select chain (`db.select(...).from(t).where(...)`) is
 * awaitable AND chainable to `.limit()` / `.orderBy()`. Mock factories
 * usually choose one shape, but the campaigns service uses both — bare
 * `where()` for `validateCampaignResources` lookups and
 * `where().limit/orderBy()` for the legacy campaign/attack reads.
 *
 * `makeAwaitableChain` returns a single object that satisfies both
 * patterns: it's a Promise that resolves to the supplied default rows,
 * but also exposes the chain methods (typically `limit` and `orderBy`)
 * attached as own properties so the next call in the chain still works.
 *
 * Use the same helper in every test file that mocks the db so future
 * shape changes only need to be made in one place.
 */
export function makeAwaitableChain(
  defaultRows: unknown[],
  chain: Record<string, unknown>
): Promise<unknown[]> & Record<string, unknown> {
  const promise = Promise.resolve(defaultRows);
  return Object.assign(promise, chain);
}
