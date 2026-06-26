/**
 * fleet-config.tsx
 *
 * Admin-only page for editing fleet-wide default agent configuration.
 *
 * Shows tuning knobs and the error whitelist only — no device picker,
 * no temperature-abort (those are hardware-bound per-rig controls, R5).
 *
 * Source computation: fleet has no parent, so a knob is 'override' when its
 * value is set, 'engine' when absent.
 */

import type { FleetDefaultConfig } from '@hashhive/shared'

import { RAW_FLAGS_MAX_LEN, WHITELIST_MAX_ENTRIES, WHITELIST_PATTERN_MAX } from '@hashhive/shared'
import { useEffect, useState } from 'react'

import {
  detectFlagConflicts,
  KnobRow,
  WhitelistEntryRow,
  WORKLOAD_OPTIONS,
} from '../components/features/config-controls'
import { Button } from '../components/ui/button'
import { ErrorBanner } from '../components/ui/error-banner'
import { Input } from '../components/ui/input'
import { PageHeader } from '../components/ui/page-header'
import { SegmentedControl } from '../components/ui/segmented-control'
import { Skeleton } from '../components/ui/skeleton'
import { useFleetDefaultConfig, useUpdateFleetDefaultConfig } from '../hooks/use-agent-config'

// ─── Form state ───────────────────────────────────────────────────────────────

interface FleetFormState {
  readonly workloadProfile: string // '' = unset (engine default)
  readonly kernelAccel: string // '' = unset
  readonly kernelLoops: string // '' = unset
  readonly rawFlags: string
  readonly whitelist: readonly string[]
}

function deriveFleetFormState(config: FleetDefaultConfig): FleetFormState {
  const tuning = config.tuning?.hashcat
  return {
    workloadProfile: tuning?.workloadProfile !== undefined ? String(tuning.workloadProfile) : '',
    kernelAccel: tuning?.kernelAccel !== undefined ? String(tuning.kernelAccel) : '',
    kernelLoops: tuning?.kernelLoops !== undefined ? String(tuning.kernelLoops) : '',
    rawFlags: tuning?.rawFlags ?? '',
    whitelist: config.errorWhitelist ?? [],
  }
}

/**
 * Build the full FleetDefaultConfig from form state.
 *
 * Fleet PATCH replaces the whole config — an absent field means "use engine
 * default". We omit any field that has no value so the server treats it as
 * unset rather than null.
 */
function buildFleetConfig(form: FleetFormState): FleetDefaultConfig {
  const workload = Number.parseInt(form.workloadProfile, 10)
  const accel = Number.parseInt(form.kernelAccel, 10)
  const loops = Number.parseInt(form.kernelLoops, 10)

  const hasHashcat =
    !Number.isNaN(workload) || !Number.isNaN(accel) || !Number.isNaN(loops) || form.rawFlags !== ''

  const config: FleetDefaultConfig = {}

  if (hasHashcat) {
    const hashcat: FleetDefaultConfig['tuning'] extends { hashcat?: infer H } | undefined
      ? NonNullable<H>
      : never = {}
    if (!Number.isNaN(workload)) hashcat.workloadProfile = workload
    if (!Number.isNaN(accel)) hashcat.kernelAccel = accel
    if (!Number.isNaN(loops)) hashcat.kernelLoops = loops
    if (form.rawFlags !== '') hashcat.rawFlags = form.rawFlags
    config.tuning = { hashcat }
  }

  if (form.whitelist.length > 0) {
    config.errorWhitelist = [...form.whitelist]
  }

  return config
}

// ─── Source computation ────────────────────────────────────────────────────────

type TwoStateSource = 'override' | 'engine'

/** Fleet has no parent: a knob is 'override' when set, 'engine' when absent. */
function knobSource(value: string): TwoStateSource {
  return value !== '' ? 'override' : 'engine'
}

// ─── Page component ───────────────────────────────────────────────────────────

export function FleetConfigPage() {
  const { data, isLoading, isError } = useFleetDefaultConfig()
  const updateConfig = useUpdateFleetDefaultConfig()

  const [form, setForm] = useState<FleetFormState | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [newPattern, setNewPattern] = useState('')

  useEffect(() => {
    if (data && !form) {
      setForm(deriveFleetFormState(data.config))
    }
  }, [data, form])

  // ── Loading / error states ─────────────────────────────────────────────────

  if (isLoading || (!data && !isError)) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader>Fleet Configuration</PageHeader>
        <div className="space-y-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader>Fleet Configuration</PageHeader>
        <ErrorBanner message="Failed to load fleet configuration. Refresh to retry." />
      </div>
    )
  }

  if (!form) return null

  // Capture narrowed references so closures and async handlers stay typed.
  const loadedData = data
  const currentForm = form
  const originalForm = deriveFleetFormState(loadedData.config)
  const isDirty = JSON.stringify(currentForm) !== JSON.stringify(originalForm)

  const flagConflicts = currentForm.rawFlags.trim() ? detectFlagConflicts(currentForm.rawFlags) : []

  function update(partial: Partial<FleetFormState>) {
    setForm((prev) => (prev ? { ...prev, ...partial } : prev))
  }

  function handleCancel() {
    setForm(deriveFleetFormState(loadedData.config))
    setSaveError(null)
    setNewPattern('')
  }

  async function handleSave() {
    setSaveError(null)
    const config = buildFleetConfig(currentForm)
    try {
      await updateConfig.mutateAsync(config)
      setForm(null)
    } catch {
      setSaveError('Failed to save fleet configuration. Please try again.')
    }
  }

  function handleAddPattern() {
    const trimmed = newPattern.trim()
    if (!trimmed || trimmed.length > WHITELIST_PATTERN_MAX) return
    if (currentForm.whitelist.includes(trimmed)) return
    if (currentForm.whitelist.length >= WHITELIST_MAX_ENTRIES) return
    update({ whitelist: [...currentForm.whitelist, trimmed] })
    setNewPattern('')
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <PageHeader>Fleet Configuration</PageHeader>
        <p className="mt-1 text-sm text-muted-foreground">
          Fleet-wide defaults inherited by all agents unless overridden per-rig.
        </p>
      </div>

      <div className="space-y-0 rounded-md border border-surface-0 bg-surface-0/40 p-4">
        {/* ── Tuning knobs ─────────────────────────────────────────────── */}
        <p className="mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Tuning
        </p>
        <div className="divide-y divide-surface-0">
          <KnobRow
            label="Workload profile"
            source={knobSource(currentForm.workloadProfile)}
            onReset={
              currentForm.workloadProfile !== '' ? () => update({ workloadProfile: '' }) : undefined
            }
          >
            <SegmentedControl
              aria-label="Workload profile"
              value={currentForm.workloadProfile || '2'}
              onChange={(v) => update({ workloadProfile: v })}
              options={WORKLOAD_OPTIONS}
            />
          </KnobRow>

          <KnobRow
            label="Kernel accel"
            htmlFor="fleet-config-kernel-accel"
            source={knobSource(currentForm.kernelAccel)}
            onReset={currentForm.kernelAccel !== '' ? () => update({ kernelAccel: '' }) : undefined}
          >
            <Input
              id="fleet-config-kernel-accel"
              type="number"
              min={1}
              placeholder="engine default"
              value={currentForm.kernelAccel}
              onChange={(e) => update({ kernelAccel: e.target.value })}
              className="max-w-[140px]"
            />
          </KnobRow>

          <KnobRow
            label="Kernel loops"
            htmlFor="fleet-config-kernel-loops"
            source={knobSource(currentForm.kernelLoops)}
            onReset={currentForm.kernelLoops !== '' ? () => update({ kernelLoops: '' }) : undefined}
          >
            <Input
              id="fleet-config-kernel-loops"
              type="number"
              min={1}
              placeholder="engine default"
              value={currentForm.kernelLoops}
              onChange={(e) => update({ kernelLoops: e.target.value })}
              className="max-w-[140px]"
            />
          </KnobRow>
        </div>

        {/* ── Additional flags ──────────────────────────────────────────── */}
        <p className="mt-4 mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Additional flags
        </p>
        <div className="space-y-1 py-2">
          <KnobRow
            label="Raw flags"
            htmlFor="fleet-config-raw-flags"
            source={knobSource(currentForm.rawFlags)}
            onReset={currentForm.rawFlags !== '' ? () => update({ rawFlags: '' }) : undefined}
          >
            <Input
              id="fleet-config-raw-flags"
              type="text"
              placeholder="e.g. --force"
              value={currentForm.rawFlags}
              onChange={(e) => update({ rawFlags: e.target.value })}
              maxLength={RAW_FLAGS_MAX_LEN}
              aria-label="Additional hashcat flags"
              aria-describedby={flagConflicts.length > 0 ? 'fleet-flag-conflict-note' : undefined}
            />
          </KnobRow>
          {flagConflicts.length > 0 && (
            <output
              id="fleet-flag-conflict-note"
              className="block text-xs text-warning"
              data-testid="flag-conflict-note"
            >
              Conflict: duplicates curated knob(s): {flagConflicts.join(', ')}. The curated value
              takes precedence; the server may reject the duplicate flag.
            </output>
          )}
        </div>

        {/* ── Error whitelist ───────────────────────────────────────────── */}
        <p className="mt-4 mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Error whitelist
        </p>
        <div className="space-y-2 py-2">
          {currentForm.whitelist.length === 0 && (
            <p className="text-xs text-muted-foreground">No fleet-wide entries configured.</p>
          )}
          {currentForm.whitelist.map((pattern) => (
            <WhitelistEntryRow
              key={pattern}
              pattern={pattern}
              isFleet={false}
              onRemove={() =>
                update({ whitelist: currentForm.whitelist.filter((p) => p !== pattern) })
              }
            />
          ))}

          {/* Add new pattern */}
          <div className="flex gap-2 pt-1">
            <Input
              type="text"
              placeholder="e.g. out of memory"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddPattern()
                }
              }}
              maxLength={WHITELIST_PATTERN_MAX}
              aria-label="New whitelist pattern"
              className="flex-1"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={handleAddPattern}
              disabled={!newPattern.trim() || currentForm.whitelist.length >= WHITELIST_MAX_ENTRIES}
            >
              Add
            </Button>
          </div>
        </div>

        {/* ── Save / Cancel ─────────────────────────────────────────────── */}
        {saveError && <ErrorBanner message={saveError} className="mt-2" />}
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-surface-0 pt-3">
          {isDirty && (
            <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
              Unsaved changes
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            disabled={!isDirty || updateConfig.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void handleSave()
            }}
            disabled={!isDirty || updateConfig.isPending}
            aria-busy={updateConfig.isPending}
          >
            {updateConfig.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
