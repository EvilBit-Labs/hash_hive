import type { InputHTMLAttributes, Ref } from 'react'

import { cn } from '../../lib/utils'

const BASE =
  'w-full rounded border border-surface-0 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary/40 disabled:opacity-50'

/** Text-compatible input types that render correctly with this component's styling. */
type TextInputType = 'text' | 'email' | 'password' | 'number' | 'search' | 'tel' | 'url'

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly type?: TextInputType
  /** React 19 ref-as-prop. Lets callers focus the input from outside (kbd shortcuts). */
  readonly ref?: Ref<HTMLInputElement>
}

export function Input({ className, ref, ...props }: InputProps) {
  return <input ref={ref} className={cn(BASE, className)} {...props} />
}
