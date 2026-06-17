import type { ResourceStatus } from '@hashhive/shared'

/**
 * Honest keyspace empty-states (issue #230).
 *
 * The campaign-detail keyspace cell shows three states: a number, "Computing...",
 * or "--". This module decides whether a null-keyspace attack is genuinely
 * *pending* (a count/compute is in flight for an input the attack's mode actually
 * consumes) versus *settled uncomputable* (so the cell should show "--").
 *
 * The mode-to-input mapping mirrors two sibling mode switches that must stay in
 * sync: `calculateAttackKeyspace` in `../keyspace.ts` and
 * `isAttackKeyspaceComputable` in `../campaigns.ts`. `loadKeyspaceInputs` in
 * `./complexity.ts` is mode-aware too - it gates the masklist input on
 * `mode === 3` - so a new mode or async input must be reflected there as well.
 * Keeping this decision in the backend (rather than the frontend guessing from
 * `wordlistId`) is deliberate: the frontend wire shape cannot distinguish
 * "masklist line-count still in flight" from "masklist counted and concluded
 * null", and a second engine (JtR) would make the mapping engine-scoped. One
 * source of truth, server-side.
 *
 * This module is pure: no DB access, no I/O. Test in isolation in
 * `tests/unit/services/keyspace-pending.test.ts`.
 */

export interface KeyspacePendingInput {
  /** Hashcat attack mode (-a flag). */
  mode: number
  /** Persisted attack keyspace (decimal string), null until computable. */
  keyspace: string | null
  /** Status of the referenced wordlist, or null when none is referenced. */
  wordlistStatus: ResourceStatus | null
  /** Status of the referenced rulelist, or null when none is referenced. */
  rulelistStatus: ResourceStatus | null
  /** Status of the referenced masklist, or null when none is referenced. */
  masklistStatus: ResourceStatus | null
}

/**
 * True while a resource's keyspace-relevant metric (line count / masklist
 * keyspace) is still in flight. Once a resource is `ready` its metric is
 * populated or definitively null; `error` means it will never compute. A null
 * status (no resource referenced) is never settling.
 *
 * Gating on `status` rather than on `lineCount IS NULL` is deliberate. A
 * chunked upload flips to `ready` before its line-count job runs (see
 * `completeChunkedUpload` in `../resources.ts`), so for a brief, self-healing
 * window a genuinely-counting resource shows "--" instead of "Computing...".
 * The alternative - treating any `ready` resource with a null line count as
 * still settling - would show "Computing..." *forever* whenever a count job
 * permanently fails: the line-count worker only ever writes `lineCount` (it
 * never touches `status`), so an abandoned job leaves the resource `ready` with
 * a null line count indefinitely. A permanent false "Computing..." is exactly
 * the dishonesty issue #230 exists to kill, so the brief transient is the
 * better trade.
 *
 * The `switch` is exhaustive over the sealed `ResourceStatus` enum on purpose:
 * a future status member trips the `satisfies never` arm at compile time,
 * forcing a deliberate settling/settled decision instead of silently defaulting
 * a new state to "settling" (another permanent false "Computing...").
 */
export function isResourceMetricSettling(status: ResourceStatus | null): boolean {
  if (status === null) return false
  switch (status) {
    case 'pending':
    case 'uploading':
    case 'uploaded':
    case 'processing':
      return true
    case 'ready':
    case 'error':
      return false
    default:
      status satisfies never
      return false
  }
}

/**
 * Decide whether a null-keyspace attack is still computing. A present keyspace
 * is never pending. For a null keyspace, only the resources the attack's mode
 * actually consumes can gate "Computing..." - a stray wordlist on a mask attack
 * does not (the #230 mode-blind bug), and a masklist that has settled to a null
 * keyspace (custom-charset `.hcmask`, #231) is uncomputable, not pending.
 */
export function isKeyspacePending(input: KeyspacePendingInput): boolean {
  if (input.keyspace !== null) return false

  const wordlist = isResourceMetricSettling(input.wordlistStatus)
  const rulelist = isResourceMetricSettling(input.rulelistStatus)
  const masklist = isResourceMetricSettling(input.masklistStatus)

  switch (input.mode) {
    case 0:
      // Straight: wordlist * max(rules, 1). Either input still settling gates.
      return wordlist || rulelist
    case 1:
      // Combination: gated on the exposed wordlist (secondary not modeled).
      return wordlist
    case 3:
      // Mask: an inline mask is synchronous (no resource); only a masklist file
      // is computed async, so only its settling state gates "Computing...".
      return masklist
    case 6:
    case 7:
      // Hybrid wordlist+mask / mask+wordlist: the mask is synchronous, so the
      // wordlist line-count is the only async input.
      return wordlist
    default:
      // PRINCE / generator / unknown modes have no async keyspace input.
      return false
  }
}
