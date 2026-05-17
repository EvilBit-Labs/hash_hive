import type { CampaignActiveAgent } from '../../hooks/use-dashboard';
import { EmptyState } from '../ui/empty-state';
import { ProgressBar } from '../ui/progress-bar';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../ui/table';

interface CampaignAgentsSectionProps {
  agents: ReadonlyArray<CampaignActiveAgent>;
}

function readPercentage(progress: unknown): number {
  if (!progress || typeof progress !== 'object') return 0;
  const p = progress as Record<string, unknown>;
  if (typeof p['percentage'] === 'number') return p['percentage'];
  if (typeof p['keyspaceProgress'] === 'number' && typeof p['total'] === 'number') {
    const total = p['total'];
    if (total > 0) return p['keyspaceProgress'] / total;
  }
  return 0;
}

function formatSpeed(speedHs: number | null): string {
  if (speedHs === null || !Number.isFinite(speedHs)) return '--';
  return `${Math.round(speedHs).toLocaleString()} H/s`;
}

/**
 * Renders the table of agents currently working on a campaign. The data
 * is sourced from the campaign detail payload's `activeAgents` array
 * (see U2 backend), which already filters to tasks in pending / assigned
 * / running statuses and caps at 50 rows.
 *
 * Real-time updates are driven centrally by `<EventsProvider>` at the
 * layout root — task_update and campaign_status events with the right
 * campaignId invalidate `['campaign', id]` and this section refetches
 * along with the rest of the detail payload.
 */
export function CampaignAgentsSection({ agents }: CampaignAgentsSectionProps) {
  if (agents.length === 0) {
    return <EmptyState message="No agents currently working on this campaign." />;
  }

  return (
    <Table>
      <TableHead>
        <tr>
          <Th>Agent</Th>
          <Th>Current Attack</Th>
          <Th>Progress</Th>
          <Th>Speed</Th>
        </tr>
      </TableHead>
      <TableBody>
        {agents.map((agent) => {
          const taskPct = readPercentage(agent.progress);
          return (
            <TableRow key={`${agent.agentId}-${agent.taskId}`}>
              <Td className="text-sm">{agent.agentName}</Td>
              <Td className="font-mono text-xs text-muted-foreground">
                Attack #{agent.attackId} - mode {agent.attackMode}
              </Td>
              <Td className="min-w-[120px]">
                <ProgressBar
                  value={taskPct}
                  size="thin"
                  ariaLabel={`${agent.agentName} task progress`}
                />
              </Td>
              <Td className="font-mono text-xs text-muted-foreground">
                {formatSpeed(agent.speedHs)}
              </Td>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
