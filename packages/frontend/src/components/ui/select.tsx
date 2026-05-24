import type { SelectHTMLAttributes } from 'react'

import { cn } from '../../lib/utils'

const BASE =
  'w-full rounded border border-surface-0 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary/40 disabled:opacity-50'

type SelectProps = SelectHTMLAttributes<HTMLSelectElement>

export function Select({ className, ...props }: SelectProps) {
  return <select className={cn(BASE, className)} {...props} />
}
