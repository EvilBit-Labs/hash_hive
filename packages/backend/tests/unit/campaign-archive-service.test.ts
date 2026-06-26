/**
 * Unit test for the archive/restore per-id error outcome (ADR-0019). A DB
 * failure on a single id must surface as an `error` outcome for that id
 * rather than rejecting the whole batch (which would become a 500). The db
 * is mocked so the failure is deterministic — this exercises error-handling
 * logic, not SQL semantics, so a mock is the right tool here.
 *
 * After U3: archiveCampaigns/restoreCampaigns do a pre-check SELECT before
 * entering a transaction, then UPDATE inside the transaction. The mock must
 * allow SELECT to succeed (returning a valid row to pass the pre-check) while
 * making UPDATE throw inside the transaction body — which drives the per-id catch.
 *
 * Isolated because mock.module('db') leaks process-wide.
 */
import { describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['CAMPAIGN_ARCHIVE_SERVICE_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('campaign-archive-service (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[campaign-archive-service] skipped — set CAMPAIGN_ARCHIVE_SERVICE_TEST_ISOLATED=1 to run.'
      )
      expect(process.env['CAMPAIGN_ARCHIVE_SERVICE_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // Shared state object — the mock closure captures this reference so tests
  // can mutate it between calls without re-registering the mock.
  const mockState = { restoreMode: false }

  // Inner tx object that throws on update (drives the per-id catch path).
  const throwingTx = {
    update: () => {
      throw new Error('simulated DB failure')
    },
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{}]) }) }),
  }

  mock.module('../../src/db/index.js', () => ({
    db: {
      // Pre-check SELECT: returns a valid row that passes pre-checks so code
      // reaches the transaction. For archive: status=completed, archivedAt=null.
      // For restore: archivedAt=<date> (archived, so restore pre-check passes).
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  id: 5,
                  projectId: 1,
                  status: 'completed',
                  archivedAt: mockState.restoreMode ? new Date('2024-01-01') : null,
                  isPermanent: true,
                },
              ]),
          }),
        }),
      }),
      // transaction executes the body with the throwing tx — update throws inside
      transaction: async (fn: (tx: typeof throwingTx) => Promise<unknown>) => fn(throwingTx),
      // top-level update (not used after U3, but keep for compat)
      update: () => {
        throw new Error('simulated DB failure')
      },
    },
  }))

  // Mock audit-log so it doesn't attempt a real db.insert
  mock.module('../../src/services/audit-log.js', () => ({
    recordAuditEvent: () => Promise.resolve({ id: 1 }),
  }))

  const { archiveCampaigns, restoreCampaigns } =
    await import('../../src/services/campaign-dashboard.js')

  describe('archive/restore per-id error outcome', () => {
    it('archiveCampaigns reports error per id when the UPDATE throws (no batch-wide failure)', async () => {
      mockState.restoreMode = false
      const res = await archiveCampaigns(1, [5, 6])
      expect(res).toEqual([
        { id: 5, outcome: 'error' },
        { id: 6, outcome: 'error' },
      ])
    })

    it('restoreCampaigns reports error per id when the UPDATE throws', async () => {
      mockState.restoreMode = true
      const res = await restoreCampaigns(1, [7])
      expect(res).toEqual([{ id: 7, outcome: 'error' }])
    })
  })
}
