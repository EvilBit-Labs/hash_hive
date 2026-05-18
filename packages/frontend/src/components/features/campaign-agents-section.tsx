import type { CampaignActiveAgent } from '../../hooks/use-dashboard';
import { readTaskPercentage } from '../../lib/campaign-progress';
import { EmptyState } from '../ui/empty-state';
import { ProgressBar } from '../ui/progress-bar';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../ui/table';

interface CampaignAgentsSectionProps {
  agents: ReadonlyArray<CampaignActiveAgent>;
}

function formatSpeed(speedHs: number | null): string {
  if (speedHs === null || !Number.isFinite(speedHs)) return '--';
  return `${Math.round(speedHs).toLocaleString()} H/s`;
}

/**
 * Renders the table of agents currently working on a campaign. The
 * data is sourced from the campaign detail payload's `activeAgents`
 * array (built by `listActiveAgentsByCampaign` in
 * `services/campaigns.ts`), which filters to tasks in pending /
 * assigned / running statuses and caps at 50 rows.
 *
 * Real-time refresh is driven centrally by `<EventsProvider>` at the
 * layout root: `task_update` and `campaign_status` events that carry
 * `campaignId` invalidate the matching `['campaign', id, projectId]`
 * cache key and this section re-renders with the new payload. Events
 * missing `campaignId` fall back to broad invalidation (see
 * `use-events.ts` campaign-scoped block).
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
          const taskPct = readTaskPercentage(agent.progress);
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
