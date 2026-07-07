import type { CampaignEta } from '@hashhive/shared'

import { formatAttackEta } from './attack-format'

const FALLBACK_DURATION = '--'

/**
 * Map the backend-derived campaign ETA (issue #100) to display copy. The
 * rollup is a discriminated union rather than a bare number so every
 * surface - campaign list row, campaign detail header - renders the same
 * honesty state instead of each caller inventing its own "no data yet"
 * string (R8/R9/R10/R16).
 *
 * `ready` and `lower_bound` reuse `formatAttackEta` for the duration part
 * so the campaign-level sum keeps the same bigint-safe `number | string`
 * handling and the `> 1 year` clamp as the per-attack cells (R7) - no
 * second duration formatter is introduced. The remaining reason states
 * never compute a number: a paused, thin-data, or fully-terminal campaign
 * shows a stated reason, never a fabricated or zero-length duration.
 */
export function formatCampaignEta(eta: CampaignEta): string {
  switch (eta.state) {
    case 'ready':
      return formatAttackEta(eta.seconds) ?? FALLBACK_DURATION
    case 'lower_bound': {
      const duration = formatAttackEta(eta.seconds) ?? FALLBACK_DURATION
      const attackNoun = eta.pendingAttacks === 1 ? 'attack' : 'attacks'
      return `≥ ${duration} (${eta.pendingAttacks} ${attackNoun} still estimating)`
    }
    case 'estimating':
      return 'Estimating...'
    case 'paused':
      return 'Paused'
    case 'no_agents':
      return 'No agents assigned'
    case 'complete':
      return 'Complete'
  }
}
