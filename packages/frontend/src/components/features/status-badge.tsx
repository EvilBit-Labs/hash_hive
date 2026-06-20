import { useEffect, useRef, useState } from 'react'

import { cn } from '../../lib/utils'

const STATUS_STYLES: Record<string, string> = {
  online: 'bg-success/15 text-success border-success/20',
  offline: 'bg-surface-1/50 text-muted-foreground border-surface-1',
  busy: 'bg-warning/15 text-warning border-warning/20',
  error: 'bg-destructive/15 text-destructive border-destructive/20',
  running: 'bg-info/15 text-info border-info/20',
  paused: 'bg-warning/15 text-warning border-warning/20',
  completed: 'bg-success/15 text-success border-success/20',
  // Attack status (issue #99): keyspace searched, no crack here. Neutral/muted
  // on purpose — green would falsely read as success, red as failure.
  exhausted: 'bg-surface-1/50 text-muted-foreground border-surface-1',
  cancelled: 'bg-surface-1/50 text-muted-foreground border-surface-1',
  pending: 'bg-surface-1/50 text-muted-foreground border-surface-1',
  failed: 'bg-destructive/15 text-destructive border-destructive/20',
  draft: 'bg-ctp-mauve/15 text-ctp-mauve border-ctp-mauve/20',
  benchmarked: 'bg-ctp-teal/15 text-ctp-teal border-ctp-teal/20',
  // Resource lifecycle states (issue #163). `uploading` and `uploaded`
  // share the in-flight blue; `processing` is the parsing intermediate
  // state for hash lists (animated dot via the `running` pulse below
  // would be ideal but the badge already gates pulse on `status ===
  // 'running'`; we use warning amber as a non-pulsing parsing cue).
  uploading: 'bg-info/15 text-info border-info/20',
  uploaded: 'bg-info/15 text-info border-info/20',
  processing: 'bg-warning/15 text-warning border-warning/20',
  ready: 'bg-success/15 text-success border-success/20',
}

/** How long the one-shot "came online" halo plays before it's removed. */
const ONLINE_PULSE_MS = 1_200

interface StatusBadgeProps {
  status: string
  /**
   * When true, the dot plays a single ping-halo each time `status`
   * transitions into 'online' — a worker coming up is a sanctioned operator
   * moment per `.impeccable.md` ("a rig transitions online → the agent
   * indicator pulses once"). Off by default so only agent rows opt in;
   * never fires on mount (a page load shouldn't pulse already-online agents).
   */
  pulseOnOnline?: boolean
}

export function StatusBadge({ status, pulseOnOnline = false }: StatusBadgeProps) {
  const styles = STATUS_STYLES[status] ?? STATUS_STYLES['pending']
  const prevStatus = useRef(status)
  const [justCameOnline, setJustCameOnline] = useState(false)

  useEffect(() => {
    if (!pulseOnOnline) return
    // Compare against the prior render's status, then record this one, so the
    // halo fires only on a real offline→online transition — not on mount and
    // not when a refetch returns the same 'online' value.
    const transitionedOnline = prevStatus.current !== 'online' && status === 'online'
    prevStatus.current = status
    if (!transitionedOnline) return
    setJustCameOnline(true)
    const timer = setTimeout(() => setJustCameOnline(false), ONLINE_PULSE_MS)
    return () => clearTimeout(timer)
  }, [status, pulseOnOnline])

  // Persistent pulse for genuinely in-flight states (distinct from the
  // one-shot transition halo above).
  const persistentPulse = status === 'running' || status === 'processing' || status === 'uploading'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize',
        styles
      )}
    >
      <span className="relative inline-flex h-1.5 w-1.5">
        {justCameOnline && (
          <span
            aria-hidden="true"
            // animate-ping does not honor prefers-reduced-motion; hide the
            // halo under reduce (the solid dot below stays visible).
            className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60 motion-reduce:hidden"
          />
        )}
        <span
          className={cn(
            'relative inline-flex h-1.5 w-1.5 rounded-full bg-current',
            persistentPulse && 'animate-pulse-gentle'
          )}
        />
      </span>
      {status}
    </span>
  )
}
