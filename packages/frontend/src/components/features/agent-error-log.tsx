import { Fragment, useState } from 'react';
import { EmptyState } from '../ui/empty-state';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../ui/table';
import { SeverityBadge } from './severity-badge';

interface AgentErrorRow {
  id: number;
  severity: string;
  message: string;
  context?: Record<string, unknown> | null;
  taskId?: number | null;
  createdAt: string;
}

interface AgentErrorLogProps {
  errors: AgentErrorRow[] | undefined;
  isError?: boolean;
}

export function AgentErrorLog({ errors, isError }: AgentErrorLogProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <section id="errors" className="space-y-3">
      <h3 className="text-sm font-medium">Error Log</h3>
      {isError ? (
        <EmptyState message="Failed to load errors — refresh to retry." />
      ) : !errors || errors.length === 0 ? (
        <EmptyState message="No errors recorded." />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <Th className="w-8" />
              <Th>Severity</Th>
              <Th>Message</Th>
              <Th>Timestamp</Th>
              <Th>Task</Th>
            </TableRow>
          </TableHead>
          <TableBody>
            {errors.map((err) => {
              const isOpen = expanded.has(err.id);
              const context = err.context ?? null;
              const hasContext =
                !!context && typeof context === 'object' && Object.keys(context).length > 0;

              return (
                <Fragment key={err.id}>
                  <TableRow>
                    <Td>
                      {hasContext ? (
                        <button
                          type="button"
                          aria-label={isOpen ? 'Collapse details' : 'Expand details'}
                          aria-expanded={isOpen}
                          onClick={() => toggleExpanded(err.id)}
                          className="rounded p-1 text-muted-foreground hover:bg-surface-0/60 hover:text-foreground"
                        >
                          <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                        </button>
                      ) : null}
                    </Td>
                    <Td>
                      <SeverityBadge severity={err.severity} />
                    </Td>
                    <Td className="text-sm">{err.message}</Td>
                    <Td className="text-xs text-muted-foreground">
                      {new Date(err.createdAt).toLocaleString()}
                    </Td>
                    <Td className="text-xs text-muted-foreground">
                      {err.taskId ? `#${err.taskId}` : '—'}
                    </Td>
                  </TableRow>
                  {isOpen && hasContext && (
                    <tr>
                      <td colSpan={5} className="bg-surface-0/30 px-4 py-3">
                        <pre className="overflow-auto font-mono text-xs leading-relaxed text-muted-foreground">
                          {JSON.stringify(context, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
