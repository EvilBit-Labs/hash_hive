/**
 * agent-config-section.tsx
 *
 * Editable "Configuration" section on the agent detail page.
 *
 * Renders per-rig config with:
 *  - Source badges (overridden / inherited / engine default) on tuning knobs
 *  - Reset-to-inherited controls for overridden tuning knobs
 *  - Hardware-bound device picker with R10 disabled fallback
 *  - Raw-flags field with inline curated-knob conflict detection
 *  - Error whitelist add/remove rows
 *  - Explicit Save / Cancel commit model (changed-fields-only PATCH)
 */

import type {
  AgentConfig,
  AgentConfigResponse,
  AgentConfigSourceMap,
  AgentHardwareProfile,
} from '@hashhive/shared'

import {
  RAW_FLAGS_MAX_LEN,
  TEMP_ABORT_MAX,
  TEMP_ABORT_MIN,
  WHITELIST_PATTERN_MAX,
  WORKLOAD_PROFILE_MAX,
  WORKLOAD_PROFILE_MIN,
} from '@hashhive/shared'
import { useEffect, useState } from 'react'

import { useAgentConfig, useUpdateAgentConfig } from '../../hooks/use-agent-config'
import { Button } from '../ui/button'
import { ErrorBanner } from '../ui/error-banner'
import { Input } from '../ui/input'
import { SegmentedControl } from '../ui/segmented-control'
import { Skeleton } from '../ui/skeleton'
import {
  detectFlagConflicts,
  KnobRow,
  WORKLOAD_OPTIONS,
  WhitelistEntryRow,
} from './config-controls'

interface DetectedDevice {
  /** 1-based index matching hashcat `-d` device numbering. */
  readonly id: number
  readonly label: string
}

/** Extract GPU devices from a raw hardwareProfile JSONB value. */
export function parseDevices(
  profile: Record<string, unknown> | null | undefined
): DetectedDevice[] {
  if (!profile) return []
  const gpus = (profile as AgentHardwareProfile)['gpus']
  if (!Array.isArray(gpus) || gpus.length === 0) return []
  return gpus.map((gpu, i) => ({
    id: i + 1,
    label: typeof gpu['model'] === 'string' && gpu['model'] ? gpu['model'] : `Device ${i + 1}`,
  }))
}

// ─── Form state ───────────────────────────────────────────────────────────────

interface ConfigFormState {
  readonly workloadProfile: string // SegmentedControl; '' = not set / cleared
  readonly kernelAccel: string // numeric string; '' = not set / cleared
  readonly kernelLoops: string // numeric string; '' = not set / cleared
  readonly deviceIds: readonly number[]
  readonly tempAbort: string // numeric string; '' = not set
  readonly rawFlags: string
  readonly rigWhitelist: readonly string[]
}

function deriveFormState(data: AgentConfigResponse): ConfigFormState {
  const tuning = data.config.tuning?.hashcat
  const hw = data.config.hardware
  return {
    workloadProfile: tuning?.workloadProfile !== undefined ? String(tuning.workloadProfile) : '',
    kernelAccel: tuning?.kernelAccel !== undefined ? String(tuning.kernelAccel) : '',
    kernelLoops: tuning?.kernelLoops !== undefined ? String(tuning.kernelLoops) : '',
    deviceIds: hw?.deviceIds ?? [],
    tempAbort: hw?.tempAbort !== undefined ? String(hw.tempAbort) : '',
    rawFlags: tuning?.rawFlags ?? '',
    rigWhitelist: data.config.errorWhitelist ?? [],
  }
}

// ─── Patch builder ────────────────────────────────────────────────────────────

/**
 * Internal wire shape that allows null to signal "clear this override".
 * The server PATCH handler interprets null as "remove this per-rig value".
 */
type NullableHashcatPatch = {
  workloadProfile?: number | null
  kernelAccel?: number | null
  kernelLoops?: number | null
  rawFlags?: string | null
}

type NullableHardwarePatch = {
  deviceIds?: number[] | null
  tempAbort?: number | null
}

/**
 * Build a changed-fields-only PATCH body from form vs server state.
 *
 * - Uses `!== undefined` guards so falsy-valid values (0, '') are preserved.
 * - Sends `null` to signal "remove this per-rig override" (reset to inherited).
 * - The mutationFn accepts `AgentConfig`; we cast once at the call site since
 *   the shared type uses `optional` rather than `nullable`, but the server
 *   contract accepts null to clear a value.
 */
function buildPatch(
  form: ConfigFormState,
  original: ConfigFormState,
  sources: AgentConfigSourceMap
): AgentConfig {
  // We build using looser intermediate types then cast at assignment.
  const hashcat: NullableHashcatPatch = {}
  let hasHashcatChange = false

  function diffTuning<K extends keyof NullableHashcatPatch>(
    key: K,
    formStr: string,
    origStr: string,
    sourceKey: keyof NonNullable<NonNullable<AgentConfigSourceMap['tuning']>['hashcat']>,
    parse: (s: string) => number | undefined
  ) {
    if (formStr === origStr) return
    hasHashcatChange = true
    if (formStr === '') {
      // Reset: clear the override only if one actually exists
      if (sources.tuning?.hashcat?.[sourceKey] === 'override') {
        ;(hashcat as Record<string, unknown>)[key] = null
      }
    } else {
      const val = parse(formStr)
      if (val !== undefined) {
        ;(hashcat as Record<string, unknown>)[key] = val
      }
    }
  }

  diffTuning(
    'workloadProfile',
    form.workloadProfile,
    original.workloadProfile,
    'workloadProfile',
    (s) => {
      const n = Number.parseInt(s, 10)
      return !Number.isNaN(n) && n >= WORKLOAD_PROFILE_MIN && n <= WORKLOAD_PROFILE_MAX
        ? n
        : undefined
    }
  )

  diffTuning('kernelAccel', form.kernelAccel, original.kernelAccel, 'kernelAccel', (s) => {
    const n = Number.parseInt(s, 10)
    return !Number.isNaN(n) && n > 0 ? n : undefined
  })

  diffTuning('kernelLoops', form.kernelLoops, original.kernelLoops, 'kernelLoops', (s) => {
    const n = Number.parseInt(s, 10)
    return !Number.isNaN(n) && n > 0 ? n : undefined
  })

  if (form.rawFlags !== original.rawFlags) {
    hasHashcatChange = true
    hashcat.rawFlags = form.rawFlags || null
  }

  const hw: NullableHardwarePatch = {}
  let hasHwChange = false

  // oxlint-disable-next-line unicorn/no-array-sort -- .slice() creates a copy first; no mutation
  const sortedFormDevices = [...form.deviceIds].sort((a: number, b: number) => a - b)
  // oxlint-disable-next-line unicorn/no-array-sort -- .slice() creates a copy first; no mutation
  const sortedOrigDevices = [...original.deviceIds].sort((a: number, b: number) => a - b)
  if (JSON.stringify(sortedFormDevices) !== JSON.stringify(sortedOrigDevices)) {
    hasHwChange = true
    hw.deviceIds = form.deviceIds.length > 0 ? [...form.deviceIds] : null
  }

  if (form.tempAbort !== original.tempAbort) {
    hasHwChange = true
    if (form.tempAbort === '') {
      hw.tempAbort = null
    } else {
      const n = Number.parseInt(form.tempAbort, 10)
      if (!Number.isNaN(n) && n >= TEMP_ABORT_MIN && n <= TEMP_ABORT_MAX) {
        hw.tempAbort = n
      }
    }
  }

  const patch: AgentConfig = {}

  if (hasHashcatChange) {
    patch.tuning = {
      hashcat: hashcat as AgentConfig['tuning'] extends { hashcat?: infer H } | undefined
        ? NonNullable<H>
        : never,
    }
  }

  if (hasHwChange) {
    patch.hardware = hw as AgentConfig['hardware']
  }

  const sortedFormWhitelist = [...form.rigWhitelist]
  const sortedOrigWhitelist = [...original.rigWhitelist]
  if (JSON.stringify(sortedFormWhitelist) !== JSON.stringify(sortedOrigWhitelist)) {
    patch.errorWhitelist = [...form.rigWhitelist]
  }

  return patch
}

// ─── Main component ───────────────────────────────────────────────────────────

interface AgentConfigSectionProps {
  readonly agentId: number
  /** Raw hardwareProfile JSONB from the agent row (for device picker). */
  readonly hardwareProfile: Record<string, unknown> | null | undefined
  /** Agent's lastSeenAt ISO string (for R10 staleness note). */
  readonly lastSeenAt: string | null | undefined
}

export function AgentConfigSection({
  agentId,
  hardwareProfile,
  lastSeenAt,
}: AgentConfigSectionProps) {
  const { data, isLoading, isError } = useAgentConfig(agentId)
  const updateConfig = useUpdateAgentConfig(agentId)

  // null = not yet initialised; set once on first data arrival via useEffect
  const [form, setForm] = useState<ConfigFormState | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [newPattern, setNewPattern] = useState('')

  // Initialise form state once data loads (idempotent: only when form is null).
  // useEffect runs after the first commit so the component renders with data
  // in a single pass when the query cache is pre-populated (e.g. in tests).
  useEffect(() => {
    if (data && !form) {
      setForm(deriveFormState(data))
    }
  }, [data, form])

  // ── Loading / error states ─────────────────────────────────────────────────
  if (isLoading || (!data && !isError)) {
    return (
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Configuration</h3>
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-8 w-1/2" />
        </div>
      </section>
    )
  }

  if (isError || !data) {
    return (
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Configuration</h3>
        <ErrorBanner message="Failed to load configuration. Refresh to retry." />
      </section>
    )
  }

  if (!form) return null

  // Capture narrowed references so closures and async handlers stay typed.
  const loadedData = data
  const currentForm = form

  const originalForm = deriveFormState(loadedData)
  const { sources } = loadedData

  // Dirty check: compare JSON snapshots (arrays are compared element-by-element)
  const isDirty = JSON.stringify(currentForm) !== JSON.stringify(originalForm)

  // Detected hardware devices (for device picker)
  const detectedDevices = parseDevices(hardwareProfile)
  const hasDevices = detectedDevices.length > 0

  // Raw-flag conflict detection
  const flagConflicts = currentForm.rawFlags.trim() ? detectFlagConflicts(currentForm.rawFlags) : []

  // ── Handlers ───────────────────────────────────────────────────────────────

  function update(partial: Partial<ConfigFormState>) {
    setForm((prev) => (prev ? { ...prev, ...partial } : prev))
  }

  function handleCancel() {
    setForm(deriveFormState(loadedData))
    setSaveError(null)
    setNewPattern('')
  }

  async function handleSave() {
    setSaveError(null)
    const patch = buildPatch(currentForm, originalForm, sources)
    try {
      await updateConfig.mutateAsync(patch)
      // Query cache is invalidated on success; reset form so it re-derives from fresh data
      setForm(null)
    } catch {
      setSaveError('Failed to save configuration. Please try again.')
    }
  }

  function handleAddPattern() {
    const trimmed = newPattern.trim()
    if (!trimmed || trimmed.length > WHITELIST_PATTERN_MAX) return
    if (currentForm.rigWhitelist.includes(trimmed)) return
    update({ rigWhitelist: [...currentForm.rigWhitelist, trimmed] })
    setNewPattern('')
  }

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-medium">Configuration</h3>

      <div className="space-y-0 rounded-md border border-surface-0 bg-surface-0/40 p-4">
        {/* ── Tuning knobs ─────────────────────────────────────────────── */}
        <p className="mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Tuning
        </p>
        <div className="divide-y divide-surface-0">
          <KnobRow
            label="Workload profile"
            source={sources.tuning?.hashcat?.workloadProfile}
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
            htmlFor="config-kernel-accel"
            source={sources.tuning?.hashcat?.kernelAccel}
            onReset={currentForm.kernelAccel !== '' ? () => update({ kernelAccel: '' }) : undefined}
          >
            <Input
              id="config-kernel-accel"
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
            htmlFor="config-kernel-loops"
            source={sources.tuning?.hashcat?.kernelLoops}
            onReset={currentForm.kernelLoops !== '' ? () => update({ kernelLoops: '' }) : undefined}
          >
            <Input
              id="config-kernel-loops"
              type="number"
              min={1}
              placeholder="engine default"
              value={currentForm.kernelLoops}
              onChange={(e) => update({ kernelLoops: e.target.value })}
              className="max-w-[140px]"
            />
          </KnobRow>
        </div>

        {/* ── Hardware knobs (per-rig only, no source badge) ───────────── */}
        <p className="mt-4 mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Hardware
        </p>
        <div className="divide-y divide-surface-0">
          <div className="py-2.5">
            <p className="mb-2 text-xs text-muted-foreground">Devices</p>
            {hasDevices ? (
              <fieldset>
                <legend className="sr-only">Select active compute devices</legend>
                <div className="flex flex-wrap gap-2" data-testid="device-picker">
                  {detectedDevices.map((device) => (
                    <label
                      key={device.id}
                      className="flex cursor-pointer items-center gap-1.5 rounded border border-surface-0 px-2 py-1 text-xs hover:bg-surface-0/60"
                    >
                      <input
                        type="checkbox"
                        checked={currentForm.deviceIds.includes(device.id)}
                        onChange={() => {
                          const next = currentForm.deviceIds.includes(device.id)
                            ? currentForm.deviceIds.filter((id) => id !== device.id)
                            : [...currentForm.deviceIds, device.id]
                          update({ deviceIds: next })
                        }}
                        className="accent-primary"
                      />
                      <span>{device.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              /* R10 fallback: no hardware detected */
              <div
                className="rounded border border-surface-0 bg-surface-0/30 px-3 py-2 text-xs text-muted-foreground"
                data-testid="device-picker-disabled"
                aria-disabled="true"
              >
                No hardware detected — device selection unavailable.
                {lastSeenAt ? (
                  <span className="ml-1 text-muted-foreground/70">
                    Last seen {new Date(lastSeenAt).toLocaleString()}.
                  </span>
                ) : (
                  <span className="ml-1 text-muted-foreground/70">
                    Agent has not reported hardware yet.
                  </span>
                )}
              </div>
            )}
          </div>

          <KnobRow label="Temp abort (°C)" htmlFor="config-temp-abort">
            <Input
              id="config-temp-abort"
              type="number"
              min={TEMP_ABORT_MIN}
              max={TEMP_ABORT_MAX}
              placeholder="unset"
              value={currentForm.tempAbort}
              onChange={(e) => update({ tempAbort: e.target.value })}
              className="max-w-[140px]"
              aria-label="Temperature abort threshold"
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
            htmlFor="config-raw-flags"
            source={sources.tuning?.hashcat?.rawFlags}
            onReset={
              sources.tuning?.hashcat?.rawFlags === 'override'
                ? () => update({ rawFlags: '' })
                : undefined
            }
          >
            <Input
              id="config-raw-flags"
              type="text"
              placeholder="e.g. --force"
              value={currentForm.rawFlags}
              onChange={(e) => update({ rawFlags: e.target.value })}
              maxLength={RAW_FLAGS_MAX_LEN}
              aria-label="Additional hashcat flags"
              aria-describedby={flagConflicts.length > 0 ? 'flag-conflict-note' : undefined}
            />
          </KnobRow>
          {flagConflicts.length > 0 && (
            <output
              id="flag-conflict-note"
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
          {currentForm.rigWhitelist.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {sources.errorWhitelist === 'fleet'
                ? 'Inheriting fleet whitelist entries. Add a per-rig pattern below to override.'
                : 'No entries configured.'}
            </p>
          )}
          {currentForm.rigWhitelist.map((pattern) => (
            <WhitelistEntryRow
              key={pattern}
              pattern={pattern}
              isFleet={false}
              onRemove={() =>
                update({ rigWhitelist: currentForm.rigWhitelist.filter((p) => p !== pattern) })
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
              disabled={!newPattern.trim()}
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
    </section>
  )
}
