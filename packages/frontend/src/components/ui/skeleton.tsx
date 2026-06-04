import type { HTMLAttributes } from 'react'

import { cn } from '../../lib/utils'

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  readonly className?: string
}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('bg-surface-0/60 animate-pulse rounded-md', className)}
      {...props}
    />
  )
}
