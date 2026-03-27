import { useParams } from 'react-router';
import { StatusBadge } from '../components/features/status-badge';
import { EmptyState } from '../components/ui/empty-state';
import { PageHeader } from '../components/ui/page-header';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table';
import { TextLink } from '../components/ui/text-link';
import { useAgent, useAgentBenchmarks, useAgentErrors } from '../hooks/use-dashboard';

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const agentId = Number(id);
  const { data: agentData, isLoading } = useAgent(agentId);
  const { data: errorsData } = useAgentErrors(agentId);
  const { data: benchmarksData, isLoading: isBenchmarksLoading } = useAgentBenchmarks(agentId);

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
        <div className="flex items-center gap-3">
          <PageHeader>{agent.name}</PageHeader>
          <StatusBadge status={agent.status} />
        </div>
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
              <dt className="text-muted-foreground">Last Seen</dt>
              <dd className="text-xs">
                {agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : 'Never'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Created</dt>
              <dd className="text-xs">{new Date(agent.createdAt).toLocaleString()}</dd>
            </div>
          </dl>
        </div>

        {agent.hardwareProfile && (
          <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Hardware
            </h3>
            <pre className="overflow-auto font-mono text-xs leading-relaxed text-muted-foreground">
              {JSON.stringify(agent.hardwareProfile, null, 2)}
            </pre>
          </div>
        )}

        {agent.capabilities && (
          <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Capabilities
            </h3>
            <pre className="overflow-auto font-mono text-xs leading-relaxed text-muted-foreground">
              {JSON.stringify(agent.capabilities, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {errorsData?.errors && errorsData.errors.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Recent Errors</h3>
          <div className="space-y-2">
            {errorsData.errors.map((err) => (
              <div
                key={err.id}
                className="rounded-md border border-destructive/20 bg-destructive/5 p-3"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-destructive">{err.severity}</span>
                  <span className="text-muted-foreground">
                    {new Date(err.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 text-sm text-foreground">{err.message}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Benchmarks</h3>
        {isBenchmarksLoading ? (
          <EmptyState message="Loading benchmarks..." />
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
      </div>
    </div>
  );
}
