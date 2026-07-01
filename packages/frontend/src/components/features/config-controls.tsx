/**
 * config-controls.tsx
 *
 * Shared presentational sub-components and pure helpers for agent / fleet
 * configuration editors. Extracted so both AgentConfigSection (per-rig) and
 * FleetConfigPage (fleet-wide defaults) can reuse them without copy-paste.
 */

import type { ConfigValueSource } from '@hashhive/shared'

import { WORKLOAD_PROFILE_MAX, WORKLOAD_PROFILE_MIN } from '@hashhive/shared'

import { ConfigSourceBadge } from './config-source-badge'

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Hashcat flags that duplicate a curated knob in this UI.
 * Used for inline conflict warnings in the raw-flags field.
 */
export const FLAG_CONFLICT_MAP: Readonly<Record<string, string>> = {
  '-w': 'workload profile',
  '--workload-profile': 'workload profile',
  '-d': 'device selection',
  '--opencl-device-types': 'device selection',
  '-n': 'kernel accel',
  '--kernel-accel': 'kernel accel',
  '-u': 'kernel loops',
  '--kernel-loops': 'kernel loops',
  '--hwmon-temp-abort': 'temperature abort',
  '-T': 'temperature abort',
}

export const WORKLOAD_LABELS: Readonly<Record<string, string>> = {
  '1': '1 – Low',
  '2': '2 – Default',
  '3': '3 – High',
  '4': '4 – Nightmare',
}

export const WORKLOAD_OPTIONS = Array.from(
  { length: WORKLOAD_PROFILE_MAX - WORKLOAD_PROFILE_MIN + 1 },
  (_, i) => {
    const val = String(WORKLOAD_PROFILE_MIN + i)
    return { value: val, label: WORKLOAD_LABELS[val] ?? val }
  }
)

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Parse raw-flags string into list of conflict labels. */
export function detectFlagConflicts(rawFlags: string): string[] {
  const conflicts = new Set<string>()
  for (const tok of rawFlags.trim().split(/\s+/)) {
    if (!tok) continue
    const flag = tok.split('=')[0] ?? tok
    const label = FLAG_CONFLICT_MAP[flag]
    if (label) conflicts.add(label)
  }
  return Array.from(conflicts)
}

// ─── KnobRow ─────────────────────────────────────────────────────────────────

export interface KnobRowProps {
  readonly label: string
  readonly htmlFor?: string
  // exactOptionalPropertyTypes: must explicitly include undefined to accept
  // values from optional-chained index expressions
  readonly source?: ConfigValueSource | undefined
  readonly onReset?: (() => void) | undefined
  readonly children: React.ReactNode
}

export function KnobRow({ label, htmlFor, source, onReset, children }: KnobRowProps) {
  return (
    <div className="flex flex-wrap items-start gap-3 py-2.5">
      <label htmlFor={htmlFor} className="w-32 shrink-0 pt-2 text-xs text-muted-foreground">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      <div className="flex shrink-0 items-center gap-2 pt-1.5">
        {source !== undefined && <ConfigSourceBadge source={source} />}
        {source === 'override' && onReset && (
          <button
            type="button"
            onClick={onReset}
            className="text-[10px] text-primary underline underline-offset-2 hover:no-underline"
            aria-label={`Reset ${label} to inherited value`}
          >
            reset
          </button>
        )}
      </div>
    </div>
  )
}

// ─── WhitelistEntryRow ───────────────────────────────────────────────────────

export interface WhitelistEntryRowProps {
  readonly pattern: string
  readonly isFleet: boolean
  readonly onRemove?: () => void
}

export function WhitelistEntryRow({ pattern, isFleet, onRemove }: WhitelistEntryRowProps) {
  return (
    <div className="flex items-center gap-2 rounded border border-surface-0 bg-surface-0/30 px-3 py-1.5">
      <span className="flex-1 truncate font-mono text-xs text-foreground">{pattern}</span>
      {isFleet ? (
        <span className="rounded bg-surface-0/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          fleet
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Remove pattern ${pattern}`}
          onClick={onRemove}
          className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          ×
        </button>
      )}
    </div>
  )
}
