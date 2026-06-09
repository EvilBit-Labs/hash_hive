import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

import { EASE_OUT_EXPO } from '../../../lib/motion-tokens'
import { cn } from '../../../lib/utils'

interface CrackRatePercentProps {
  /** Crack rate as a percent in [0, 100]. */
  readonly value: number
  /** Optional extra classes for the surrounding wrapper. */
  readonly className?: string
}

const MILESTONE_THRESHOLD = 99.95
const MILESTONE_UPPER_BOUND = 100.5
const TRANSITION_DURATION_S = 0.6

/**
 * Inline percentage rendering for crack rate. Used by both the
 * campaign-detail Results tab and the hash-list detail Cracked view
 * to render the completion-moment treatment described in
 * .impeccable.md ("A campaign completes -> the card acknowledges it").
 * At 100% (within rounding — threshold 99.95) the figure flips from
 * muted to peach + semibold; sub-100% renders in the muted treatment.
 *
 * Defensive against wire-data drift: NaN / Infinity / negative inputs
 * render as a neutral hyphen so a race between cracked and hash counts
 * doesn't surface "(NaN%)" or "(Infinity%)" to the operator. Values
 * above MILESTONE_UPPER_BOUND (101.5%) get a console warning so the
 * data drift is debuggable — the figure itself stays honest about the
 * broken number rather than silently clamping.
 *
 * The transition into 100% is a one-time scale lift (subsequent
 * renders stay in the milestone treatment without re-animating). If
 * the value drops back below 100% and re-crosses, the milestone
 * replays — intentional: a hash list that gains new hashes and gets
 * re-completed is a fresh operator moment.
 */
export function CrackRatePercent({ value, className }: CrackRatePercentProps) {
  const prefersReducedMotion = useReducedMotion()
  const isFiniteRate = Number.isFinite(value)
  // Coerce -0 to 0 so the formatter doesn't render `-0.0%`.
  const normalized = value === 0 ? 0 : value
  const isComplete = isFiniteRate && normalized >= MILESTONE_THRESHOLD
  const wasCompleteRef = useRef(isComplete)
  const [crossedKey, setCrossedKey] = useState(0)

  useEffect(() => {
    if (isComplete && !wasCompleteRef.current) {
      setCrossedKey((k) => k + 1)
    }
    wasCompleteRef.current = isComplete
  }, [isComplete])

  // Warn (once per render-with-drift) when the wire shape lies. The
  // figure still renders honestly so the operator sees the number;
  // the console line gives engineering a trail.
  useEffect(() => {
    if (isFiniteRate && normalized > MILESTONE_UPPER_BOUND) {
      // oxlint-disable-next-line no-console -- wire-shape drift must be debuggable
      console.warn('[CrackRatePercent] value exceeds 100% — wire data race?', { value })
    }
  }, [isFiniteRate, normalized, value])

  const completeClass = cn('font-semibold text-primary tabular-nums', className)
  const mutedClass = cn('text-muted-foreground tabular-nums', className)

  if (!isFiniteRate || normalized < 0) {
    return <span className={mutedClass}>(-%)</span>
  }

  const formatted = normalized.toFixed(1)

  if (!isComplete) {
    return <span className={mutedClass}>({formatted}%)</span>
  }

  if (prefersReducedMotion) {
    return <span className={completeClass}>({formatted}%)</span>
  }

  return (
    <motion.span
      key={crossedKey}
      initial={crossedKey === 0 ? false : { scale: 0.9, opacity: 0.5 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: TRANSITION_DURATION_S, ease: EASE_OUT_EXPO }}
      className={completeClass}
    >
      ({formatted}%)
    </motion.span>
  )
}
