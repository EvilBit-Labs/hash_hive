import type { HashListTypeAnalysis } from '@hashhive/shared'

import { AlertTriangle } from 'lucide-react'

import { cn } from '../../lib/utils'

interface HashTypeWarningProps {
  readonly typeAnalysis: HashListTypeAnalysis | null
  readonly className?: string
}

const VERDICT_COPY: Record<HashListTypeAnalysis['verdict'], string> = {
  homogeneous: 'This list looks like a single hash type.',
  mixed: 'This list looks like it contains more than one hash type.',
  'needs-review': 'This list needs a closer look before cracking.',
}

/**
 * Non-blocking warning surfaced on the hash-list detail view when
 * ingestion's per-entry type detection (issue #202, FU3) found more than
 * one hash type, or couldn't identify a meaningful share of entries.
 *
 * Foundation-only: this does not offer a split action. It just tells the
 * operator what was found so they know why a mixed list won't crack
 * cleanly as a single campaign yet — the split flow is the follow-up
 * (issue #202's second half, SU1-SU6).
 *
 * Renders nothing for a homogeneous list with zero unidentified entries,
 * so normal (non-mixed) hash lists see zero visual change.
 */
export function HashTypeWarning({ typeAnalysis, className }: HashTypeWarningProps) {
  // Loose-equality null check: also covers `undefined`, which shows up in
  // practice for callers/fixtures built against a hash list detail row that
  // predates the nullable `typeAnalysis` column (issue #202, FU4).
  if (typeAnalysis == null) return null

  const { verdict, detectedModes, unidentifiedCount, scannedCount, sampled } = typeAnalysis
  const isClean = verdict === 'homogeneous' && unidentifiedCount === 0
  if (isClean) return null

  const modeCount = detectedModes.length

  return (
    <div
      className={cn(
        'flex gap-3 rounded-md border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning',
        className
      )}
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="space-y-1.5">
        <p className="font-medium">{VERDICT_COPY[verdict]}</p>

        {modeCount > 1 && (
          <p className="text-warning/90">
            {modeCount} hash types detected during ingestion:{' '}
            {detectedModes
              .map((mode) => `mode ${mode.hashcatMode} (${formatCount(mode.count, scannedCount)})`)
              .join(', ')}
            .
          </p>
        )}

        {unidentifiedCount > 0 && (
          <p className="text-warning/90">
            {unidentifiedCount.toLocaleString()} of {scannedCount.toLocaleString()} scanned entries
            couldn&apos;t be identified.
          </p>
        )}

        {sampled && (
          <p className="text-xs text-warning/70">
            Based on a sample of the first {scannedCount.toLocaleString()} entries — this is a large
            list, so we didn&apos;t scan every row.
          </p>
        )}

        <p className="text-xs text-warning/70">
          Mixed lists can&apos;t be cracked as a single campaign yet. Splitting into typed sub-lists
          is coming soon.
        </p>
      </div>
    </div>
  )
}

function formatCount(count: number, scannedCount: number): string {
  if (scannedCount <= 0) return count.toLocaleString()
  const pct = (count / scannedCount) * 100
  return `${count.toLocaleString()}, ${pct.toFixed(0)}%`
}
