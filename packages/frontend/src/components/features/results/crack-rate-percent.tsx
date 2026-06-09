import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '../../../lib/utils'

interface CrackRatePercentProps {
  /** Crack rate as a percent (0–100). Used both for the display and for the 100% milestone gate. */
  readonly value: number
  /** Optional extra classes for the surrounding wrapper. */
  readonly className?: string
}

const MILESTONE_THRESHOLD = 99.95
const TRANSITION_DURATION_S = 0.6
const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

/**
 * Inline percentage rendering for crack rate. At 100% (within
 * rounding) the figure flips from muted text to peach + semibold —
 * .impeccable.md's "A campaign completes -> the campaign card
 * acknowledges it" moment, applied to hash list completion. The
 * transition into 100% is a one-time scale lift; subsequent renders
 * stay in the milestone treatment without re-animating. Reduced-
 * motion users see the static milestone color without the lift.
 */
export function CrackRatePercent({ value, className }: CrackRatePercentProps) {
  const prefersReducedMotion = useReducedMotion()
  const isFiniteRate = Number.isFinite(value)
  const isComplete = isFiniteRate && value >= MILESTONE_THRESHOLD
  const wasCompleteRef = useRef(isComplete)
  const [crossedKey, setCrossedKey] = useState(0)

  useEffect(() => {
    if (isComplete && !wasCompleteRef.current) {
      setCrossedKey((k) => k + 1)
    }
    wasCompleteRef.current = isComplete
  }, [isComplete])

  const baseClass = cn('tabular-nums', className)
  const completeClass = cn('font-semibold text-primary', baseClass)
  const mutedClass = cn('text-muted-foreground', baseClass)

  // NaN / Infinity / negative inputs render as a neutral hyphen so a
  // race between cracked and hash counts doesn't surface "NaN%" or
  // "Infinity%" to the operator.
  if (!isFiniteRate || value < 0) {
    return <span className={mutedClass}>(-%)</span>
  }

  const formatted = value.toFixed(1)

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
      transition={{ duration: TRANSITION_DURATION_S, ease: [...EASE_OUT_EXPO] }}
      className={completeClass}
    >
      ({formatted}%)
    </motion.span>
  )
}
