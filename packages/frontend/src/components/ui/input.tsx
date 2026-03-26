import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const BASE =
  'w-full rounded border border-surface-0 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary/40 disabled:opacity-50';

/** Text-compatible input types that render correctly with this component's styling. */
type TextInputType = 'text' | 'email' | 'password' | 'number' | 'search' | 'tel' | 'url';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly type?: TextInputType;
}

export function Input({ className, ...props }: InputProps) {
  return <input className={cn(BASE, className)} {...props} />;
}
