import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

import { EASE_OUT_EXPO } from '../../../lib/motion-tokens'
import { cn } from '../../../lib/utils'

interface TickingNumberProps {
  /** Current value to render. Numerical formatting is the caller's job. */
  readonly value: number
  /** Pre-formatted text to display (e.g. `1,283`). */
  readonly children: string | number
  /** Extra classes for the rendered span. */
  readonly className?: string
}

const TICK_DURATION_S = 0.6
const DELTA_VISIBLE_MS = 2500
const DELTA_DISMISS_DURATION_S = 0.35

/**
 * Above this delta the +N chip stops being informative and starts
 * being noise — a chip reading "+412" doesn't help an operator who
 * was already watching the figure tick. Calibrated as a UX threshold,
 * not an empirical claim about crack rate; tune as the surface
 * evolves.
 */
const MAX_PLAUSIBLE_DELTA = 200

// Color tokens live on className as inline CSS variables; Motion
// dereferences them via `var()` in animate so theme changes track
// without remounting the component.
const TICK_VARS =
  '[--tick-flash:hsl(var(--primary))] ' +
  '[--tick-base:hsl(var(--foreground))] ' +
  '[--delta-bg:hsl(var(--primary)/0.18)] ' +
  '[--delta-fg:hsl(var(--primary))]'

/**
 * Inline-stats counterpart to the ResultsTable row pulse. When the
 * value goes UP between renders (a 30s poll lands new cracks), the
 * figure briefly flashes peach + scales up, then settles back to the
 * foreground color. A `+N` chip slides in next to the figure for
 * 2.5s carrying the delta — the operator's "yes, N cracks just
 * landed" peak-end acknowledgment.
 *
 * The `prev > 0` guard excludes filter changes (which often drop to
 * zero before refilling); the MAX_PLAUSIBLE_DELTA guard excludes
 * project switches / huge filter widenings where a +N badge would be
 * noise. NaN / Infinity / negative values are also ignored so a wire
 * shape race can't poison `prevValueRef` and silently disable future
 * ticks. Reduced-motion users see a static figure update with no
 * badge.
 *
 * When updates arrive faster than the chip's 2.5s dismiss timer, the
 * displayed delta accumulates (e.g. 1283 -> 1286 -> 1289 surfaces as
 * "+6") so a dense run of cracks doesn't visually shrink to the most
 * recent single-tick delta.
 */
export function TickingNumber({ value, children, className }: TickingNumberProps) {
  const prefersReducedMotion = useReducedMotion()
  const prevValueRef = useRef(value)
  const [tickKey, setTickKey] = useState(0)
  const [delta, setDelta] = useState<number | null>(null)
  const pendingDeltaRef = useRef(0)

  useEffect(() => {
    const prev = prevValueRef.current
    // Defend against wire-data drift (NaN, Infinity, negative). A bad
    // value would otherwise poison `prevValueRef` and disable future
    // ticks; ignore it and leave the ref pointing at the last good
    // value.
    if (!Number.isFinite(value) || value < 0) return
    prevValueRef.current = value
    if (prev <= 0 || value <= prev) return
    const d = value - prev
    if (d > MAX_PLAUSIBLE_DELTA) return
    pendingDeltaRef.current += d
    setTickKey((k) => k + 1)
    setDelta(pendingDeltaRef.current)
    const t = window.setTimeout(() => {
      pendingDeltaRef.current = 0
      setDelta(null)
    }, DELTA_VISIBLE_MS)
    return () => window.clearTimeout(t)
  }, [value])

  if (prefersReducedMotion) {
    return <span className={className}>{children}</span>
  }

  return (
    <span className={cn('inline-flex items-baseline gap-1.5', TICK_VARS)}>
      <motion.span
        key={tickKey}
        initial={tickKey === 0 ? false : { opacity: 0.4, scale: 0.92, color: 'var(--tick-flash)' }}
        animate={{ opacity: 1, scale: 1, color: 'var(--tick-base)' }}
        transition={{ duration: TICK_DURATION_S, ease: EASE_OUT_EXPO }}
        className={className}
      >
        {children}
      </motion.span>
      <AnimatePresence>
        {delta !== null && (
          <motion.span
            key={`delta-${tickKey}`}
            initial={{ opacity: 0, y: -4, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -2, transition: { duration: DELTA_DISMISS_DURATION_S } }}
            transition={{ duration: TICK_DURATION_S, ease: EASE_OUT_EXPO }}
            style={{
              backgroundColor: 'var(--delta-bg)',
              color: 'var(--delta-fg)',
            }}
            className="inline-flex items-center rounded-sm px-1 font-mono text-xs leading-tight font-medium tabular-nums"
          >
            +{delta}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}
