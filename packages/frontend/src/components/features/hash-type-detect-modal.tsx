import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'

import {
  useDetectHashTypeBatch,
  useHashLists,
  useHashTypes,
  useSetHashListType,
} from '../../hooks/use-resources'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { EmptyState } from '../ui/empty-state'
import { ErrorBanner } from '../ui/error-banner'
import { Select } from '../ui/select'

const MIN_SAMPLES = 5
const MAX_SAMPLES = 10

// Operator-facing keyboard hints. ⌘ on macOS, Ctrl elsewhere, evaluated
// once at module load. SSR-safe via the typeof guard; defaults to the
// non-Mac form so the first paint never claims a key the user doesn't
// have. Matches the brand context's principle #4 ("Keyboard is a
// first-class peer of mouse").
const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform)
const SUBMIT_KEY_HINT = isMac ? '⌘ ⏎' : 'Ctrl ⏎'

// Same shape as the dashboard's KBD_BASE_CLASS (dashboard.tsx:20) so
// the kbd chip reads consistently across the app — small mono pill on
// surface-0 with a subtle border.
const KBD_CHIP =
  'border-surface-1 bg-surface-0/80 text-foreground/85 ml-2 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border px-1 font-mono text-[10px] font-medium leading-none'

interface HashTypeDetectModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Page-level hash type detection. The textarea accepts 5-10 newline-
 * separated samples, posts to the shipped batch endpoint (max 100
 * server-side), and renders per-candidate confidence. An optional list
 * picker turns "Use This Type" from a read-only identification into a
 * write action that updates the picked hash list's `hashTypeId` via
 * `PATCH /dashboard/resources/hash-lists/{id}`.
 *
 * The "Use This Type" button is disabled with a tooltip when no list
 * is selected, so the operator never wonders whether the click did
 * anything - the affordance state matches the available action.
 */
export function HashTypeDetectModal({ open, onClose }: HashTypeDetectModalProps) {
  const [rawText, setRawText] = useState('')
  const [selectedListId, setSelectedListId] = useState<number | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [pendingApplyMode, setPendingApplyMode] = useState<number | null>(null)

  const hashLists = useHashLists()
  const hashTypes = useHashTypes()
  const detect = useDetectHashTypeBatch()
  const setType = useSetHashListType(selectedListId ?? 0)

  // Lookup table from hashcatMode → hash_types.id (the PK). The
  // detect-hash-type response only exposes hashcatMode on candidates,
  // but PATCH /hash-lists/{id} takes the hash_types PK (referenced
  // by the hash_lists.hash_type_id FK). Without this lookup, "Use
  // This Type" would send the mode as the id and either FK-violate
  // (most cases) or silently set the wrong type (when serial id
  // coincidentally equals mode). The hash_types list is small and
  // already cached at the page level.
  const hashTypeIdByMode = useMemo(() => {
    const map = new Map<number, number>()
    for (const ht of hashTypes.data?.hashTypes ?? []) {
      map.set(ht.hashcatMode, ht.id)
    }
    return map
  }, [hashTypes.data])

  const samples = useMemo(
    () =>
      rawText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [rawText]
  )

  const sampleCount = samples.length
  const inRange = sampleCount >= MIN_SAMPLES && sampleCount <= MAX_SAMPLES

  const helperMessage = (() => {
    if (sampleCount === 0) return `Paste ${MIN_SAMPLES} to ${MAX_SAMPLES} hashes, one per line.`
    if (sampleCount < MIN_SAMPLES)
      return `Add ${MIN_SAMPLES - sampleCount} more line${MIN_SAMPLES - sampleCount === 1 ? '' : 's'} to meet the minimum of ${MIN_SAMPLES}.`
    if (sampleCount > MAX_SAMPLES)
      return `Remove ${sampleCount - MAX_SAMPLES} line${sampleCount - MAX_SAMPLES === 1 ? '' : 's'} to fit the maximum of ${MAX_SAMPLES}.`
    return `${sampleCount} sample${sampleCount === 1 ? '' : 's'} ready.`
  })()

  // Flatten the wire shape - `results[]` is one entry per input hash; we
  // collapse to a single deduped candidate list ordered by the highest
  // confidence seen across all input hashes. This matches how an
  // operator reads the table: "which hash type best explains my
  // inputs?" - not "what did each input look like?"
  const flatCandidates = useMemo(() => {
    if (!detect.data) return []
    const seen = new Map<
      number,
      { name: string; hashcatMode: number; category: string; confidence: number }
    >()
    for (const result of detect.data.results) {
      for (const candidate of result.candidates) {
        const existing = seen.get(candidate.hashcatMode)
        if (!existing || candidate.confidence > existing.confidence) {
          seen.set(candidate.hashcatMode, {
            name: candidate.name,
            hashcatMode: candidate.hashcatMode,
            category: candidate.category,
            confidence: candidate.confidence,
          })
        }
      }
    }
    // oxlint-disable-next-line unicorn/no-array-sort -- Array.from already returns a fresh array; the in-place sort is safe and tsconfig 'lib' doesn't include es2023's toSorted
    return Array.from(seen.values()).sort((a, b) => b.confidence - a.confidence)
  }, [detect.data])

  const handleDetect = () => {
    if (!inRange) return
    setSubmitError(null)
    detect.mutate(samples, {
      onError: (err) => {
        setSubmitError(err instanceof Error ? err.message : 'Detection failed. Try again.')
      },
    })
  }

  const inFlight = detect.isPending || setType.isPending

  const handleTextareaKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Submit on Ctrl/Cmd + Enter so operators can paste-then-trigger
    // from the keyboard without reaching for the mouse. Block while
    // any mutation is in flight so a fresh detect can't race the
    // pending set-type apply.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && inRange && !inFlight) {
      e.preventDefault()
      handleDetect()
    }
  }

  const handleUseType = (hashcatMode: number) => {
    if (selectedListId === null) return
    const target = flatCandidates.find((c) => c.hashcatMode === hashcatMode)
    if (!target) return
    const hashTypeId = hashTypeIdByMode.get(target.hashcatMode)
    if (hashTypeId === undefined) {
      setSubmitError(
        `Hash type for mode ${target.hashcatMode} ("${target.name}") is not registered server-side. ` +
          'Ask an admin to seed it before applying.'
      )
      return
    }
    setPendingApplyMode(hashcatMode)
    setSubmitError(null)
    setType.mutate(
      { hashTypeId },
      {
        onSuccess: () => {
          setPendingApplyMode(null)
          handleClose()
        },
        onError: (err) => {
          setPendingApplyMode(null)
          setSubmitError(err instanceof Error ? err.message : 'Failed to set hash type.')
        },
      }
    )
  }

  const handleClose = () => {
    setRawText('')
    setSelectedListId(null)
    setSubmitError(null)
    setPendingApplyMode(null)
    detect.reset()
    onClose()
  }

  // Esc-to-close. The brand promises keyboard is a first-class peer of
  // mouse and the surfaced "Esc" hint on the Close button has to be
  // honored — this isn't a native <dialog>, so we wire the handler
  // here. Skipped when an apply mutation is in flight so the operator
  // can't accidentally orphan a pending PATCH.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !inFlight) {
        e.preventDefault()
        handleClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // handleClose is defined inline above; tracking `open` and
    // `inFlight` is enough — the closure re-binds on each render
    // anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inFlight])

  if (!open) return null

  const availableLists = hashLists.data?.hashLists ?? []

  return (
    <div className="bg-crust/80 fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom modal: native <dialog> doesn't support the design system's surface tokens
        role="dialog"
        aria-modal="true"
        aria-labelledby="hash-type-detect-title"
        className="border-surface-0 bg-mantle w-full max-w-3xl rounded-lg border p-6 shadow-2xl"
      >
        {/* Header: title + apply target. The picker lives here (not
            buried mid-form) so the operator's apply destination is
            visible context throughout the flow — both before they
            paste samples and while they're reading results. */}
        <header className="border-surface-0/60 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b pb-5">
          <div className="space-y-1">
            <h3
              id="hash-type-detect-title"
              className="text-foreground text-base font-medium tracking-tight"
            >
              Detect Hash Type
            </h3>
            <p className="text-muted-foreground text-xs">
              Identify sample hashes and apply the chosen type to a hash list.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label
              htmlFor="hash-type-target-list"
              className="text-muted-foreground text-xs font-medium whitespace-nowrap"
            >
              Apply to
            </label>
            <Select
              id="hash-type-target-list"
              value={selectedListId ?? ''}
              onChange={(e) =>
                setSelectedListId(e.target.value === '' ? null : Number(e.target.value))
              }
              disabled={detect.isPending || setType.isPending}
              className="min-w-[14rem]"
            >
              <option value="">Pick a list to apply...</option>
              {availableLists.map((hl) => (
                <option key={hl.id} value={hl.id}>
                  {hl.name}
                </option>
              ))}
            </Select>
          </div>
        </header>

        {submitError !== null && <ErrorBanner message={submitError} className="mt-4" />}

        {/* Primary input: paste samples. Generous top padding (pt-5)
            distinguishes this from the header band; tight internal
            grouping (label → textarea → helper, 1.5/1.5 spacing)
            reads as one unit. */}
        <div className="pt-5">
          <label htmlFor="hash-type-samples" className="text-muted-foreground text-xs font-medium">
            Sample hashes <span className="text-overlay1">(one per line)</span>
          </label>
          <textarea
            id="hash-type-samples"
            aria-label="Sample hashes"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            disabled={inFlight}
            rows={6}
            className="border-surface-1 bg-base focus-visible:ring-primary mt-1.5 w-full rounded-md border px-3 py-2 font-mono text-xs focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
            placeholder={`Paste ${MIN_SAMPLES}-${MAX_SAMPLES} hashes, one per line`}
            aria-describedby="hash-type-samples-help"
          />
          <p id="hash-type-samples-help" className="text-muted-foreground mt-1.5 text-xs">
            {helperMessage}
          </p>
        </div>

        {/* Results: phase transition from input to output. The top
            candidate lands as a verdict — large scale, peach accent,
            primary apply button — so the operator's eye snaps to "the
            answer." Remaining candidates collapse into a dense
            runners-up list with ghost apply buttons. This is the
            "dramatic ops theater" the brand context calls for, kept
            inside the editorial color budget (one peach-tinted block,
            not gradient noise). */}
        {detect.data && (
          <section className="pt-6">
            <h4 className="text-foreground text-xs font-medium">Results</h4>
            {flatCandidates.length === 0 ? (
              <div className="mt-2">
                <EmptyState message="No hash types matched the samples provided. Try different samples or paste more hashes." />
              </div>
            ) : (
              <>
                <Verdict
                  candidate={flatCandidates[0]!}
                  selectedListId={selectedListId}
                  hashTypesReady={!hashTypes.isLoading && Boolean(hashTypes.data)}
                  pendingApplyMode={pendingApplyMode}
                  setTypePending={setType.isPending}
                  onApply={handleUseType}
                />
                {flatCandidates.length > 1 && (
                  <RunnersUp
                    candidates={flatCandidates.slice(1)}
                    selectedListId={selectedListId}
                    hashTypesReady={!hashTypes.isLoading && Boolean(hashTypes.data)}
                    pendingApplyMode={pendingApplyMode}
                    setTypePending={setType.isPending}
                    onApply={handleUseType}
                  />
                )}
              </>
            )}
          </section>
        )}

        {/* Footer: structural separator (border-t) marks the actions
            row as distinct from the body. gap-2 keeps the two
            buttons tight as siblings. */}
        <footer className="border-surface-0/60 mt-6 flex justify-end gap-2 border-t pt-5">
          <Button variant="secondary" onClick={handleClose} disabled={inFlight}>
            Close
            <kbd className={KBD_CHIP} aria-hidden="true">
              Esc
            </kbd>
          </Button>
          <Button onClick={handleDetect} disabled={!inRange || inFlight}>
            {detect.isPending ? 'Detecting...' : 'Detect'}
            <kbd
              // Stays dim when the button itself is disabled so the kbd
              // chip doesn't look freshly clickable on an inert button.
              className={cn(KBD_CHIP, (!inRange || inFlight) && 'opacity-50')}
              aria-hidden="true"
            >
              {SUBMIT_KEY_HINT}
            </kbd>
          </Button>
        </footer>
      </div>
    </div>
  )
}

// ─── Verdict + RunnersUp ────────────────────────────────────────────
//
// Sub-components for the results section. Split out so the JSX in
// the modal body stays readable; the two pieces share the apply-state
// computation but have very different visual treatments.

interface Candidate {
  name: string
  hashcatMode: number
  category: string
  confidence: number
}

interface VerdictProps {
  candidate: Candidate
  selectedListId: number | null
  hashTypesReady: boolean
  pendingApplyMode: number | null
  setTypePending: boolean
  onApply: (hashcatMode: number) => void
}

function applyDisabledReason(
  selectedListId: number | null,
  hashTypesReady: boolean
): string | undefined {
  if (selectedListId === null) return 'Pick a hash list above to enable'
  if (!hashTypesReady) return 'Loading hash types...'
  return undefined
}

/**
 * Top candidate, rendered as the lead. Three signals carry the
 * verdict treatment: scale (text-4xl vs text-sm), color (peach accent
 * on a subtle peach-tinted surface), and weight (primary button vs
 * ghost). Mode + category sit underneath in monospace as supporting
 * micro-type so the operator can verify the answer at a glance.
 */
function Verdict({
  candidate,
  selectedListId,
  hashTypesReady,
  pendingApplyMode,
  setTypePending,
  onApply,
}: VerdictProps) {
  const pct = Math.round(candidate.confidence * 100)
  const isApplying = pendingApplyMode === candidate.hashcatMode
  const otherApplying = pendingApplyMode !== null && !isApplying
  const reason = applyDisabledReason(selectedListId, hashTypesReady)
  const disabled = reason !== undefined || setTypePending || otherApplying

  return (
    <article
      className="border-primary/15 bg-primary/5 mt-3 rounded-lg border p-5"
      aria-label="Top match"
    >
      <div className="flex items-baseline justify-between gap-6">
        <div className="min-w-0">
          <h5 className="text-foreground text-4xl font-medium tracking-tight">{candidate.name}</h5>
          <p className="text-muted-foreground mt-2 font-mono text-xs">
            Mode {candidate.hashcatMode} · {candidate.category}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div
            className="text-primary text-4xl font-medium tabular-nums"
            aria-label={`Confidence ${pct} percent`}
          >
            {pct}%
          </div>
          <p className="text-muted-foreground mt-2 text-xs tracking-wide uppercase">Confidence</p>
        </div>
      </div>
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- styled bar: native <progress> doesn't respect the brand's peach/surface tokens or the rounded-full geometry; div with ARIA role is the documented escape hatch
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${candidate.name} confidence`}
        className="bg-surface-1/60 mt-5 h-2 w-full overflow-hidden rounded-full"
      >
        <div
          className="bg-primary h-full rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-5 flex justify-end">
        <Button
          variant="primary"
          onClick={() => onApply(candidate.hashcatMode)}
          disabled={disabled}
          title={reason}
        >
          {isApplying ? 'Applying...' : 'Use This Type'}
        </Button>
      </div>
    </article>
  )
}

interface RunnersUpProps {
  candidates: readonly Candidate[]
  selectedListId: number | null
  hashTypesReady: boolean
  pendingApplyMode: number | null
  setTypePending: boolean
  onApply: (hashcatMode: number) => void
}

/**
 * Remaining candidates after the lead. Dense, single-row layout —
 * everything visually subordinate to the Verdict above. Ghost apply
 * buttons reinforce that these are the runners-up, not the answer.
 */
function RunnersUp({
  candidates,
  selectedListId,
  hashTypesReady,
  pendingApplyMode,
  setTypePending,
  onApply,
}: RunnersUpProps) {
  return (
    <div className="mt-5">
      <p className="text-muted-foreground mb-2 text-xs font-medium">Other candidates</p>
      <ul className="border-surface-0/60 divide-surface-0/60 divide-y rounded-md border">
        {candidates.map((c) => {
          const pct = Math.round(c.confidence * 100)
          const isApplying = pendingApplyMode === c.hashcatMode
          const otherApplying = pendingApplyMode !== null && !isApplying
          const reason = applyDisabledReason(selectedListId, hashTypesReady)
          const disabled = reason !== undefined || setTypePending || otherApplying
          return (
            <li key={c.hashcatMode} className="flex items-center gap-4 px-4 py-2.5 text-xs">
              <div className="flex min-w-0 flex-1 items-baseline gap-3">
                <span className="text-foreground text-sm font-medium">{c.name}</span>
                <span className="text-muted-foreground font-mono">{c.hashcatMode}</span>
                <span className="text-muted-foreground truncate">{c.category}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- styled bar: native <progress> doesn't respect the brand's peach/surface tokens or the rounded-full geometry; div with ARIA role is the documented escape hatch
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${c.name} confidence`}
                  className="bg-surface-1 h-1.5 w-16 overflow-hidden rounded-full"
                >
                  <div className="bg-primary/70 h-full rounded-full" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-muted-foreground w-9 text-right font-mono tabular-nums">
                  {pct}%
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onApply(c.hashcatMode)}
                disabled={disabled}
                title={reason}
                className="shrink-0"
              >
                {isApplying ? 'Applying...' : 'Use This Type'}
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
