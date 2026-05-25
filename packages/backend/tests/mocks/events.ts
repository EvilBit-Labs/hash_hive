/**
 * Shared events.js mock factory for test files.
 *
 * Background: bun:test's `mock.module` merges into the real module's ESM
 * namespace, but in practice non-listed exports get replaced with
 * undefined when other test files in the same phase mock the module with
 * a partial set. The canonical workaround (per GOTCHAS.md "Shared module
 * cache gotcha") is to list every export the worker / route / service
 * code under test transitively imports.
 *
 * This factory centralizes that list so adding a new EventService export
 * touches one file instead of N test files. Tests pass an optional
 * overrides object to inject specific spies for the events they care
 * about asserting on:
 *
 *     mock.module('../../src/services/events.js', createEventsMockFactory({
 *       emitCampaignStatus: customMock,
 *     }))
 *
 * Anything not overridden becomes a fresh `mock()` no-op.
 */
import { mock } from 'bun:test'

export type EventsMockFactory = () => Record<string, unknown>

export function createEventsMockFactory(
  overrides: Record<string, unknown> = {}
): EventsMockFactory {
  return () => ({
    // Project-scoped event emitters
    emit: mock(),
    emitAgentStatus: mock(),
    emitAgentError: mock(),
    emitCampaignStatus: mock(),
    emitTaskUpdate: mock(),
    emitCrackResult: mock(),
    emitResourceUpdate: mock(),
    // System-wide broadcast
    broadcastSystemHealth: mock(),
    // Client registry — test-only utilities the production code reads.
    registerClient: mock(),
    unregisterClient: mock(),
    getClientCount: mock(() => 0),
    __resetEventsForTesting: mock(),
    // Per-test overrides win.
    ...overrides,
  })
}
