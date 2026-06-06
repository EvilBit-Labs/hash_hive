import { type KeyboardEvent, useMemo, useState } from 'react'

import {
  useDetectHashTypeBatch,
  useHashLists,
  useHashTypes,
  useSetHashListType,
} from '../../hooks/use-resources'
import { Button } from '../ui/button'
import { EmptyState } from '../ui/empty-state'
import { ErrorBanner } from '../ui/error-banner'
import { Select } from '../ui/select'
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../ui/table'

const MIN_SAMPLES = 5
const MAX_SAMPLES = 10

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

  if (!open) return null

  const availableLists = hashLists.data?.hashLists ?? []

  return (
    <div className="bg-crust/80 fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom modal: native <dialog> doesn't support the design system's surface tokens
        role="dialog"
        aria-modal="true"
        aria-labelledby="hash-type-detect-title"
        className="border-surface-0 bg-mantle w-full max-w-2xl rounded-lg border p-6 shadow-2xl"
      >
        <h3 id="hash-type-detect-title" className="mb-4 text-sm font-medium">
          Detect Hash Type
        </h3>

        {submitError !== null && <ErrorBanner message={submitError} className="mb-4" />}

        <div className="space-y-4">
          <div>
            <label
              htmlFor="hash-type-samples"
              className="text-muted-foreground text-xs font-medium"
            >
              Sample hashes (one per line)
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

          <div>
            <label
              htmlFor="hash-type-target-list"
              className="text-muted-foreground text-xs font-medium"
            >
              Apply to hash list (optional)
            </label>
            <Select
              id="hash-type-target-list"
              value={selectedListId ?? ''}
              onChange={(e) =>
                setSelectedListId(e.target.value === '' ? null : Number(e.target.value))
              }
              disabled={detect.isPending || setType.isPending}
              className="mt-1.5 w-full"
            >
              <option value="">- Detect only (read-only) -</option>
              {availableLists.map((hl) => (
                <option key={hl.id} value={hl.id}>
                  {hl.name}
                </option>
              ))}
            </Select>
          </div>

          {detect.data && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium">Results</h4>
              {flatCandidates.length === 0 ? (
                <EmptyState message="No hash types matched the samples provided. Try different samples or paste more hashes." />
              ) : (
                <Table>
                  <TableHead>
                    <tr>
                      <Th>Type</Th>
                      <Th>Mode</Th>
                      <Th>Category</Th>
                      <Th>Confidence</Th>
                      <Th>
                        <span className="sr-only">Apply</span>
                      </Th>
                    </tr>
                  </TableHead>
                  <TableBody>
                    {flatCandidates.map((c) => {
                      const isApplying = pendingApplyMode === c.hashcatMode
                      const otherApplying = pendingApplyMode !== null && !isApplying
                      const applyDisabled =
                        selectedListId === null || setType.isPending || otherApplying
                      return (
                        <TableRow key={c.hashcatMode}>
                          <Td className="text-foreground text-sm font-medium">{c.name}</Td>
                          <Td className="font-mono text-xs">{c.hashcatMode}</Td>
                          <Td className="text-muted-foreground text-xs">{c.category}</Td>
                          <Td>
                            <div className="flex items-center gap-2">
                              <div className="bg-surface-1 h-1.5 w-20 rounded-full">
                                <div
                                  className="bg-primary h-full rounded-full transition-all"
                                  style={{ width: `${Math.round(c.confidence * 100)}%` }}
                                />
                              </div>
                              <span className="text-muted-foreground font-mono text-xs">
                                {Math.round(c.confidence * 100)}%
                              </span>
                            </div>
                          </Td>
                          <Td className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleUseType(c.hashcatMode)}
                              disabled={applyDisabled || hashTypes.isLoading || !hashTypes.data}
                              title={
                                selectedListId === null
                                  ? 'Pick a hash list above to apply'
                                  : hashTypes.isLoading || !hashTypes.data
                                    ? 'Loading hash type registry...'
                                    : undefined
                              }
                            >
                              {isApplying ? 'Applying...' : 'Use This Type'}
                            </Button>
                          </Td>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={handleClose} disabled={inFlight}>
            Close
          </Button>
          <Button onClick={handleDetect} disabled={!inRange || inFlight}>
            {detect.isPending ? 'Detecting...' : 'Detect'}
          </Button>
        </div>
      </div>
    </div>
  )
}
