import type { ImportFormat, ImportSummary } from '@hashhive/shared'
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react'

import { IMPORT_CONTENT_MAX_LENGTH } from '@hashhive/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useImportPrecracked } from '../../hooks/use-hash-import'
import { useHashListSummaries } from '../../hooks/use-hash-lists'
import { cn } from '../../lib/utils'
import { useUiStore } from '../../stores/ui'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { ErrorBanner } from '../ui/error-banner'
import { Select } from '../ui/select'

type Phase = 'input' | 'summary'

const FORMAT_OPTIONS: Array<{ value: ImportFormat; label: string }> = [
  { value: 'pairs', label: 'Hash:plaintext pairs' },
  { value: 'hashcat-potfile', label: 'Hashcat potfile' },
  { value: 'john-potfile', label: 'John potfile' },
]

interface HashImportModalProps {
  open: boolean
  onClose: () => void
  /**
   * When set, the target hash list is pre-selected and the selector
   * still shows so the operator can change it if needed.
   */
  preselectedHashListId?: number
}

export function HashImportModal({ open, onClose, preselectedHashListId }: HashImportModalProps) {
  const queryClient = useQueryClient()
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const importMutation = useImportPrecracked()
  const hashListsQuery = useHashListSummaries({ enabled: open })

  const [phase, setPhase] = useState<Phase>('input')
  const [targetListId, setTargetListId] = useState(
    preselectedHashListId !== undefined ? String(preselectedHashListId) : ''
  )
  const [format, setFormat] = useState<ImportFormat>('pairs')
  const [file, setFile] = useState<File | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Re-apply the preselected id when the modal opens or when the
  // prop changes (e.g. navigating between hash-list detail pages).
  useEffect(() => {
    if (open) {
      setTargetListId(preselectedHashListId !== undefined ? String(preselectedHashListId) : '')
    }
  }, [open, preselectedHashListId])

  const hashLists = hashListsQuery.data?.hashLists ?? []
  const listOptions = hashLists.map((hl) => ({
    value: String(hl.id),
    label: hl.name,
  }))

  const isSubmitting = importMutation.isPending
  const canSubmit = targetListId !== '' && file !== null && !isSubmitting

  // ─── File selection ───────────────────────────────────────────────

  const adoptFile = useCallback((selected: File | null) => {
    if (selected !== null && selected.size > IMPORT_CONTENT_MAX_LENGTH) {
      setError('File too large (max 32 MB)')
      setFile(null)
      return
    }
    setFile(selected)
    setError(null)
  }, [])

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    adoptFile(e.target.files?.[0] ?? null)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (!isSubmitting) setIsDragOver(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget === e.target) setIsDragOver(false)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    if (isSubmitting) return
    const dropped = e.dataTransfer.files[0] ?? null
    if (dropped) adoptFile(dropped)
  }

  // Keyboard activation for the dropzone.
  const handleDropzoneKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isSubmitting) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fileInputRef.current?.click()
    }
  }

  // ─── Submit ───────────────────────────────────────────────────────

  const handleImport = async () => {
    if (!canSubmit || !file) return
    setError(null)

    try {
      const content = await file.text()
      const hashListId = Number(targetListId)
      const result = await importMutation.mutateAsync({ hashListId, content, format })
      setSummary(result)
      setPhase('summary')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    }
  }

  // ─── Reset and close ─────────────────────────────────────────────

  const handleReset = useCallback(() => {
    setPhase('input')
    setTargetListId(preselectedHashListId !== undefined ? String(preselectedHashListId) : '')
    setFormat('pairs')
    setFile(null)
    setIsDragOver(false)
    setError(null)
    setSummary(null)
    importMutation.reset()
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [preselectedHashListId, importMutation])

  /** Close from the summary phase — invalidates caches before dismissing. */
  const handleSummaryClose = useCallback(() => {
    const id = Number(targetListId)
    void queryClient.invalidateQueries({ queryKey: ['hash-list-items', id] })
    void queryClient.invalidateQueries({ queryKey: ['results'] })
    // Invalidate the summary list so the cracked-count badge refreshes, and
    // the detail so the hash-list detail panel shows up-to-date stats.
    void queryClient.invalidateQueries({ queryKey: ['hash-list-summaries', selectedProjectId] })
    void queryClient.invalidateQueries({ queryKey: ['hash-list-detail', id] })
    handleReset()
    onClose()
  }, [queryClient, targetListId, selectedProjectId, handleReset, onClose])

  /** Close from the input phase — just dismiss. */
  const handleInputClose = useCallback(() => {
    handleReset()
    onClose()
  }, [handleReset, onClose])

  const handleOpenChange = (next: boolean) => {
    if (!next && !isSubmitting) {
      if (phase === 'summary') {
        handleSummaryClose()
      } else {
        handleInputClose()
      }
    }
  }

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* showCloseButton disabled: both phases have explicit close/cancel
          footer buttons. The X button would produce a second element with
          the "Close" accessible name and confuse click-by-text queries. */}
      <DialogContent showCloseButton={false} className="max-w-lg">
        {phase === 'input' ? (
          <>
            <DialogHeader>
              <DialogTitle>Import Pre-cracked Hashes</DialogTitle>
              <DialogDescription>
                Upload a file of known hash/plaintext pairs to update an existing hash list.
                Propagation to results runs asynchronously in the background.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {error && <ErrorBanner message={error} />}

              {/* Target hash list selector (required) */}
              <div>
                <label
                  htmlFor="import-target-list"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Target hash list
                </label>
                <Select
                  id="import-target-list"
                  aria-label="Target hash list"
                  value={targetListId}
                  onValueChange={setTargetListId}
                  options={listOptions}
                  placeholder={hashListsQuery.isLoading ? 'Loading lists...' : 'Choose a hash list'}
                  disabled={isSubmitting || hashListsQuery.isLoading}
                  className="mt-1.5 w-full"
                />
              </div>

              {/* Format selector */}
              <div>
                <label
                  htmlFor="import-format"
                  className="text-xs font-medium text-muted-foreground"
                >
                  File format
                </label>
                <Select
                  id="import-format"
                  aria-label="File format"
                  value={format}
                  onValueChange={(v) => {
                    if (v === 'pairs' || v === 'hashcat-potfile' || v === 'john-potfile') {
                      setFormat(v)
                    }
                  }}
                  options={FORMAT_OPTIONS}
                  disabled={isSubmitting}
                  className="mt-1.5 w-full"
                />
              </div>

              {/* File drop zone */}
              <div>
                <label htmlFor="import-file" className="text-xs font-medium text-muted-foreground">
                  File
                </label>
                <div
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- dropzone: needs to be a div to accept drag events on its full bounding box without nested-button focus traps
                  role="button"
                  tabIndex={isSubmitting ? -1 : 0}
                  aria-label="Drop file here, or press Enter to browse"
                  aria-disabled={isSubmitting}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onKeyDown={handleDropzoneKeyDown}
                  onClick={() => !isSubmitting && fileInputRef.current?.click()}
                  className={cn(
                    'mt-1.5 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-6 text-center focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none',
                    isDragOver
                      ? 'border-primary bg-primary/5'
                      : 'border-surface-1 hover:border-surface-0',
                    isSubmitting && 'cursor-not-allowed opacity-60'
                  )}
                >
                  {file ? (
                    <>
                      <p className="text-xs font-medium text-foreground">{file.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {(file.size / 1024).toFixed(1)} KB
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-xs font-medium text-foreground">
                        Drop a file here or click to browse
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Pairs, hashcat potfile, or John potfile
                      </p>
                    </>
                  )}
                  <input
                    id="import-file"
                    ref={fileInputRef}
                    type="file"
                    aria-label="Import file"
                    onChange={handleFileChange}
                    disabled={isSubmitting}
                    className="sr-only"
                  />
                </div>
              </div>

              {/* Indeterminate progress during submission */}
              {isSubmitting && (
                <div className="space-y-1">
                  <progress
                    className="h-1.5 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-surface-1 [&::-webkit-progress-value]:bg-primary"
                    aria-label="Submitting import..."
                  />
                  <p className="text-xs text-muted-foreground">Submitting...</p>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="secondary" onClick={handleInputClose} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button onClick={() => void handleImport()} disabled={!canSubmit}>
                {isSubmitting ? 'Importing...' : 'Import'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          /* Summary phase */
          <>
            <DialogHeader>
              <DialogTitle>Import queued</DialogTitle>
              <DialogDescription>
                Your file was accepted and is being processed. These counts reflect this list&apos;s
                hashes only — propagation to results runs in the background.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2 rounded-md border border-surface-0 bg-surface-0/40 p-4">
              <SummaryRow label="Matched in list" value={summary?.matchedInList ?? 0} />
              <SummaryRow label="Cracked" value={summary?.crackedInList ?? 0} accent="success" />
              <SummaryRow label="Skipped" value={summary?.skipped ?? 0} />
            </div>

            <DialogFooter>
              <Button onClick={handleSummaryClose}>Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function SummaryRow({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: 'success'
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-mono text-sm font-medium tabular-nums',
          accent === 'success' ? 'text-success' : 'text-foreground'
        )}
      >
        {value.toLocaleString()}
      </span>
    </div>
  )
}
