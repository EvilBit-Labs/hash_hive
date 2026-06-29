import * as React from 'react'

import { cn } from '../../lib/utils'

// shadcn Table wrapper adds a scrollable container; we keep Catppuccin border/radius on that wrapper.
function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="overflow-x-auto rounded-md border border-surface-0">
      <table
        data-slot="table"
        className={cn('w-full caption-bottom text-left text-sm', className)}
        {...props}
      />
    </div>
  )
}

// shadcn name: TableHeader → renders <thead>
// Callsite name: TableHead (14 callsites use { TableHead } to mean <thead>)
function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('border-b border-surface-0 bg-surface-0/30', className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('divide-y divide-surface-0/50', className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn('transition-colors hover:bg-surface-0/20', className)}
      {...props}
    />
  )
}

// shadcn name: TableHead → renders <th>
// Callsite name: Th (14 callsites use { Th } to mean <th>)
function TableHeadCell({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'px-4 py-2.5 text-left text-xs font-medium tracking-wider text-muted-foreground uppercase',
        className
      )}
      {...props}
    />
  )
}

// shadcn name: TableCell → renders <td>
// Callsite name: Td (14 callsites use { Td } to mean <td>)
function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={cn('px-4 py-2.5', className)} {...props} />
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Table,
  TableBody,
  TableFooter,
  // shadcn TableHeader (<thead>) → exported as TableHead to match all 14 callsites
  TableHeader as TableHead,
  TableRow,
  // shadcn TableHead (<th>) → exported as Th to match all 14 callsites
  TableHeadCell as Th,
  // shadcn TableCell (<td>) → exported as Td to match all 14 callsites
  TableCell as Td,
  TableCaption,
}
