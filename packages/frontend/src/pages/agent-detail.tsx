import { useEffect } from 'react';
import { useLocation, useParams } from 'react-router';
import { AgentErrorLog } from '../components/features/agent-error-log';
import { AgentTasksSection } from '../components/features/agent-tasks-section';
import { HardwareProfileCard } from '../components/features/hardware-profile-card';
import { StatusBadge } from '../components/features/status-badge';
import { EmptyState } from '../components/ui/empty-state';
import { PageHeader } from '../components/ui/page-header';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table';
import { TextLink } from '../components/ui/text-link';
import {
  useAgent,
  useAgentBenchmarks,
  useAgentErrors,
  useAgentTasks,
} from '../hooks/use-dashboard';
import { useEvents } from '../hooks/use-events';
import { formatPrimaryEngine, getPrimaryEngine } from '../lib/agent-capabilities';

function formatHashcatModes(capabilities: Record<string, unknown> | null | undefined): string {
  if (!capabilities) return '—';
  const modes = capabilities['hashModes'] ?? capabilities['supportedModes'];
  if (modes === undefined || modes === null) return '—';
  if (!Array.isArray(modes)) {
    // biome-ignore lint/suspicious/noConsole: surface protocol drift to operators
    console.warn('[AgentDetailPage] capabilities.hashModes has unexpected shape', modes);
    return 'invalid';
  }
  if (modes.length === 0) return '—';
  return modes.join(', ');
}

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const agentId = Number(id);
  const { hash } = useLocation();

  // React Router does not auto-scroll to URL fragments. The agent error
  // badge on the list page deep-links to /agents/:id#errors; without this,
  // the user lands at the top of the detail page and has to scroll manually.
  // The effect runs after the data resolves so the target element exists.
  useEffect(() => {
    if (!hash) return;
    const target = document.getElementById(hash.slice(1));
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [hash]);

  const { data: agentData, isLoading } = useAgent(agentId);
  const { data: errorsData, isError: isErrorsError } = useAgentErrors(agentId);
  const {
    data: tasksData,
    isLoading: isTasksLoading,
    isError: isTasksError,
  } = useAgentTasks(agentId);
  const {
    data: benchmarksData,
    isLoading: isBenchmarksLoading,
    isError: isBenchmarksError,
  } = useAgentBenchmarks(agentId);

  // Keep detail page reactive to real-time updates. useEvents handles
  // invalidation of agent / agent-errors / agent-tasks keys.
  useEvents({ types: ['agent_status', 'task_update'] });

  if (isLoading) {
    return <EmptyState message="Loading agent..." />;
  }

  const agent = agentData?.agent;
  if (!agent) {
    return (
      <div className="space-y-4">
        <TextLink to="/agents" back>
          Back to agents
        </TextLink>
        <EmptyState message="Agent not found." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <TextLink to="/agents" back>
          Back to agents
        </TextLink>
        <div className="flex flex-wrap items-center gap-3">
          <PageHeader>{agent.name}</PageHeader>
          <StatusBadge status={agent.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          Last seen: {agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : 'Never'}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
          <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Details
          </h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">ID</dt>
              <dd className="font-mono text-xs">{agent.id}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Cracker</dt>
              <dd className="font-mono text-xs">
                {formatPrimaryEngine(
                  getPrimaryEngine(agent.capabilities as Record<string, unknown> | null | undefined)
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Supported modes</dt>
              <dd className="text-right font-mono text-xs">
                {formatHashcatModes(agent.capabilities)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Created</dt>
              <dd className="text-xs">{new Date(agent.createdAt).toLocaleString()}</dd>
            </div>
          </dl>
        </div>

        <HardwareProfileCard profile={agent.hardwareProfile} />
      </div>

      <AgentTasksSection
        tasks={tasksData?.tasks}
        isLoading={isTasksLoading}
        isError={isTasksError}
      />

      <AgentErrorLog errors={errorsData?.errors} isError={isErrorsError} />

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Benchmarks</h3>
        {isBenchmarksLoading ? (
          <EmptyState message="Loading benchmarks..." />
        ) : isBenchmarksError ? (
          <EmptyState message="Failed to load benchmarks — refresh to retry." />
        ) : benchmarksData?.benchmarks && benchmarksData.benchmarks.length > 0 ? (
          <Table>
            <TableHead>
              <TableRow>
                <Th>Hash Type</Th>
                <Th>Hashcat Mode</Th>
                <Th>Speed (H/s)</Th>
                <Th>Device</Th>
                <Th>Benchmarked At</Th>
              </TableRow>
            </TableHead>
            <TableBody>
              {benchmarksData.benchmarks.map((b) => (
                <TableRow key={b.id}>
                  <Td>{b.hashType}</Td>
                  <Td className="font-mono text-xs">{b.hashcatMode}</Td>
                  <Td className="font-mono text-xs">{b.speedHs.toLocaleString()}</Td>
                  <Td>{b.deviceName}</Td>
                  <Td className="text-xs">{new Date(b.benchmarkedAt).toLocaleString()}</Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState message="No benchmarks recorded yet." />
        )}
      </section>
    </div>
  );
}
