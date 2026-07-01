import type { ExportFormat, ExportScope, ExportVariant } from '@hashhive/shared'

import { useCallback, useEffect, useState } from 'react'

import { type ExportResultsFilters, useExportResults } from '../../../hooks/use-export-results'
import { type ShortcutKey, useKeyboardShortcut } from '../../../hooks/use-keyboard-shortcut'
import { useUiStore } from '../../../stores/ui'
import { Button } from '../../ui/button'
import { Kbd } from '../../ui/kbd'
import { Select } from '../../ui/select'

interface ExportButtonProps {
  readonly filters: ExportResultsFilters
  readonly label?: string
  /**
   * Optional keyboard shortcut that triggers the export from anywhere
   * on the page (modulo editable-element targets). Rendered as a
   * visible Kbd chip inside the button so operators discover the
   * shortcut at a glance.
   */
  readonly shortcutKey?: ShortcutKey
}

const SUCCESS_ACK_MS = 1500

// ─── Pure decision helpers (exported for unit testing) ──────────────────────

/**
 * Derive the initial scope selection from filter context.
 * Hash list presence takes priority over campaign, which takes priority
 * over project (the always-available fallback).
 */
export function deriveDefaultScope(filters: ExportResultsFilters): ExportScope {
  if (filters.hashListId !== undefined) return 'hash-list'
  if (filters.campaignId !== undefined) return 'campaign'
  return 'project'
}

/**
 * Returns true when a scope option should be disabled for the current
 * filter context:
 *   - 'hash-list'  requires hashListId in filters
 *   - 'campaign'   requires campaignId in filters; also disabled when
 *                  hashListId is present (hash-list scope takes precedence)
 *   - 'project'    disabled when hashListId is present (per spec)
 */
export function isScopeOptionDisabled(option: ExportScope, filters: ExportResultsFilters): boolean {
  switch (option) {
    case 'hash-list':
      return filters.hashListId === undefined
    case 'campaign':
      return filters.campaignId === undefined || filters.hashListId !== undefined
    case 'project':
      return filters.hashListId !== undefined
  }
}

/**
 * Returns true when potfile formats should be disabled.
 * Backend enforces: potfile + plaintext-only/uncracked → 400.
 * Mirror that constraint here so the operator cannot submit an invalid
 * combination.
 */
export function isPotfileFormatDisabled(variant: ExportVariant): boolean {
  return variant === 'plaintext-only' || variant === 'uncracked'
}

/**
 * Reconcile the current format selection when the variant changes.
 * If the active format would produce an invalid combination (potfile +
 * plaintext-only/uncracked), reset to CSV.
 */
export function reconcileFormat(variant: ExportVariant, format: ExportFormat): ExportFormat {
  if (isPotfileFormatDisabled(variant) && format !== 'csv') return 'csv'
  return format
}

// ─── Local helpers ────────────────────────────────────────────────────────────

function resolveErrorMessage(isError: boolean, error: unknown): string | null {
  if (!isError) return null
  if (error instanceof Error) return error.message
  return 'Export failed'
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Export trigger backed by `useExportResults`. Exposes scope, variant,
 * and format selectors so operators can customise what is downloaded.
 *
 * Scope defaults are context-aware:
 *   - hashListId in filters → locked to 'hash-list'
 *   - campaignId in filters → defaults to 'campaign'
 *   - otherwise            → 'project'
 *
 * Potfile formats are disabled when the variant is `plaintext-only`
 * or `uncracked` (mirrors the backend constraint).
 *
 * Shows a persistent note when the backend skips rows due to unknown
 * hash types (read from the `x-export-skipped` response header).
 */
export function ExportButton({ filters, label = 'Export CSV', shortcutKey }: ExportButtonProps) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const exportMutation = useExportResults()
  const [justSucceeded, setJustSucceeded] = useState(false)

  // Scope: user-adjustable, but locked to 'hash-list' when the detail
  // page provides hashListId in filters (effectiveScope overrides state).
  const [userScope, setUserScope] = useState<ExportScope>(() => deriveDefaultScope(filters))
  const [variant, setVariant] = useState<ExportVariant>('cracked-pairs')
  const [format, setFormat] = useState<ExportFormat>('csv')

  // If the current userScope is disabled for these filters (e.g. filter was
  // cleared after the user selected 'campaign', or hashListId locks to
  // 'hash-list'), fall back to the context-appropriate default.
  const effectiveScope: ExportScope = isScopeOptionDisabled(userScope, filters)
    ? deriveDefaultScope(filters)
    : userScope

  // Auto-reset format to CSV whenever variant changes to an incompatible value.
  useEffect(() => {
    setFormat((f) => reconcileFormat(variant, f))
  }, [variant])

  // Success-ack timer.
  useEffect(() => {
    if (!exportMutation.isSuccess) return
    setJustSucceeded(true)
    const t = setTimeout(() => setJustSucceeded(false), SUCCESS_ACK_MS)
    return () => clearTimeout(t)
  }, [exportMutation.isSuccess, exportMutation.submittedAt])

  // Clear the success ack the moment a new attempt starts or fails.
  useEffect(() => {
    if (exportMutation.isPending || exportMutation.isError) {
      setJustSucceeded(false)
    }
  }, [exportMutation.isPending, exportMutation.isError])

  const isDisabled = selectedProjectId === null || exportMutation.isPending

  function resolveLabel(): string {
    if (exportMutation.isPending) return 'Exporting...'
    if (justSucceeded) return 'Exported'
    return label
  }
  const buttonLabel = resolveLabel()
  const errorMessage = resolveErrorMessage(exportMutation.isError, exportMutation.error)
  const skippedCount = exportMutation.data?.skippedCount ?? 0

  const isPotfileDisabled = isPotfileFormatDisabled(variant)

  const triggerExport = useCallback(() => {
    if (isDisabled) return
    exportMutation.mutate({ ...filters, scope: effectiveScope, variant, format })
  }, [exportMutation, filters, effectiveScope, variant, format, isDisabled])

  useKeyboardShortcut(shortcutKey, triggerExport, { disabled: isDisabled })

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select
          aria-label="Export scope"
          className="h-7 px-2 text-xs"
          value={effectiveScope}
          onValueChange={(v) => setUserScope(v as ExportScope)}
          options={[
            {
              value: 'project',
              label: 'Project',
              disabled: isScopeOptionDisabled('project', filters),
            },
            {
              value: 'campaign',
              label: 'Campaign',
              disabled: isScopeOptionDisabled('campaign', filters),
            },
            {
              value: 'hash-list',
              label: 'Hash list',
              disabled: isScopeOptionDisabled('hash-list', filters),
            },
          ]}
        />
        <Select
          aria-label="Export variant"
          className="h-7 px-2 text-xs"
          value={variant}
          onValueChange={(v) => setVariant(v as ExportVariant)}
          options={[
            { value: 'cracked-pairs', label: 'Cracked pairs' },
            { value: 'plaintext-only', label: 'Plaintext only' },
            { value: 'uncracked', label: 'Uncracked' },
          ]}
        />
        <Select
          aria-label="Export format"
          className="h-7 px-2 text-xs"
          value={format}
          onValueChange={(v) => setFormat(v as ExportFormat)}
          options={[
            { value: 'csv', label: 'CSV' },
            { value: 'hashcat-potfile', label: 'Hashcat potfile', disabled: isPotfileDisabled },
            { value: 'john-potfile', label: 'John potfile', disabled: isPotfileDisabled },
          ]}
        />
        <Button variant="secondary" size="sm" disabled={isDisabled} onClick={triggerExport}>
          <span className="inline-flex items-center gap-1.5">
            {buttonLabel}
            {shortcutKey && !isDisabled && !justSucceeded && <Kbd>{shortcutKey}</Kbd>}
          </span>
        </Button>
      </div>
      {errorMessage && (
        <span role="alert" className="text-xs text-destructive">
          {errorMessage}
        </span>
      )}
      {!errorMessage && exportMutation.isSuccess && skippedCount > 0 && (
        <span role="alert" className="text-xs text-info">
          {`Exported. ${skippedCount} ${skippedCount === 1 ? 'row' : 'rows'} skipped (hash type unknown).`}
        </span>
      )}
    </div>
  )
}
