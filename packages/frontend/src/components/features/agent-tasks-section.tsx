import type { AgentTask } from '../../hooks/use-dashboard';
import { EmptyState } from '../ui/empty-state';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../ui/table';
import { TextLink } from '../ui/text-link';
import { StatusBadge } from './status-badge';

interface AgentTasksSectionProps {
  tasks: AgentTask[] | undefined;
  isLoading: boolean;
  isError?: boolean;
}

function progressPercent(progress: Record<string, unknown>): string {
  const value = progress['percent'] ?? progress['completed'] ?? progress['progress'];
  if (value === undefined || value === null) return '—';
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // biome-ignore lint/suspicious/noConsole: surface protocol drift to operators
    console.warn('[AgentTasksSection] non-numeric progress.percent', value);
    return 'invalid';
  }
  return `${Math.round(value)}%`;
}

function progressSpeed(progress: Record<string, unknown>): string {
  const speed = progress['speedHs'] ?? progress['speed'];
  if (speed === undefined || speed === null) return '—';
  if (typeof speed !== 'number' || !Number.isFinite(speed)) {
    // biome-ignore lint/suspicious/noConsole: surface protocol drift to operators
    console.warn('[AgentTasksSection] non-numeric progress.speed', speed);
    return 'invalid';
  }
  return `${speed.toLocaleString()} H/s`;
}

export function AgentTasksSection({ tasks, isLoading, isError }: AgentTasksSectionProps) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Current Tasks</h3>
      {isLoading ? (
        <EmptyState message="Loading tasks..." />
      ) : isError ? (
        <EmptyState message="Failed to load tasks — refresh to retry." />
      ) : !tasks || tasks.length === 0 ? (
        <EmptyState message="No active tasks assigned." />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <Th>Campaign</Th>
              <Th>Attack</Th>
              <Th>Status</Th>
              <Th>Progress</Th>
              <Th>Speed</Th>
            </TableRow>
          </TableHead>
          <TableBody>
            {tasks.map((task) => {
              const progress = task.progress ?? {};
              return (
                <TableRow key={task.id}>
                  <Td className="text-sm">
                    <TextLink to={`/campaigns/${task.campaignId}`}>{task.campaignName}</TextLink>
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    Mode {task.attackMode} (#{task.attackId})
                  </Td>
                  <Td>
                    <StatusBadge status={task.status} />
                  </Td>
                  <Td className="font-mono text-xs">{progressPercent(progress)}</Td>
                  <Td className="font-mono text-xs">{progressSpeed(progress)}</Td>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
