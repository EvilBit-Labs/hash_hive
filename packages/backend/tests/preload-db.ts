/**
 * Preload for the real-DB integration lane (`tests/db`).
 *
 * Reuses the standard test env (`preload.ts`) — which already points
 * `DATABASE_URL` at the dedicated `hashhive_test` database — but, unlike the
 * default lane, tests loaded under this preload do NOT mock the drizzle client.
 * They open real connections to a live Postgres/TimescaleDB instance prepared by
 * `setup-test-db.ts`.
 *
 * Keeping the env in one place (`preload.ts`) avoids drift between the two lanes.
 */

import './preload.ts'
