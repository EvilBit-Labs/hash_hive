import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'

import { cn } from '../../lib/utils'

export function Table({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('border-surface-0 overflow-x-auto rounded-md border', className)} {...props}>
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  )
}

export function TableHead({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cn('border-surface-0 bg-surface-0/30 border-b', className)} {...props}>
      {children}
    </thead>
  )
}

export function TableBody({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cn('divide-surface-0/50 divide-y', className)} {...props}>
      {children}
    </tbody>
  )
}

export function TableRow({ className, children, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn('hover:bg-surface-0/20 transition-colors', className)} {...props}>
      {children}
    </tr>
  )
}

export function Th({ className, children, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'text-muted-foreground px-4 py-2.5 text-xs font-medium tracking-wider uppercase',
        className
      )}
      {...props}
    >
      {children}
    </th>
  )
}

export function Td({ className, children, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('px-4 py-2.5', className)} {...props}>
      {children}
    </td>
  )
}
