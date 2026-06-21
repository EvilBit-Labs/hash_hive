/**
 * Unit test for the archive/restore per-id error outcome (ADR-0019). A DB
 * failure on a single id must surface as an `error` outcome for that id
 * rather than rejecting the whole batch (which would become a 500). The db
 * is mocked so the failure is deterministic — this exercises error-handling
 * logic, not SQL semantics, so a mock is the right tool here.
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
  // Mock the db so every UPDATE throws — drives the per-id catch.
  mock.module('../../src/db/index.js', () => ({
    db: {
      update: () => {
        throw new Error('simulated DB failure')
      },
    },
  }))

  const { archiveCampaigns, restoreCampaigns } =
    await import('../../src/services/campaign-dashboard.js')

  describe('archive/restore per-id error outcome', () => {
    it('archiveCampaigns reports error per id when the UPDATE throws (no batch-wide failure)', async () => {
      const res = await archiveCampaigns(1, [5, 6])
      expect(res).toEqual([
        { id: 5, outcome: 'error' },
        { id: 6, outcome: 'error' },
      ])
    })

    it('restoreCampaigns reports error per id when the UPDATE throws', async () => {
      const res = await restoreCampaigns(1, [7])
      expect(res).toEqual([{ id: 7, outcome: 'error' }])
    })
  })
}
