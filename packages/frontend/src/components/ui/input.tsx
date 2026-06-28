import * as React from 'react'

import { cn } from '../../lib/utils'

// type is the full React.ComponentProps<'input'>['type'] union (relaxed from the prior constrained
// TextInputType — non-breaking since callers only pass the previously-allowed subset).
// React 19 ref-as-prop: ref rides through {...props} spread with no forwardRef needed.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'w-full rounded border border-surface-0 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary/40 disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}

export { Input }
