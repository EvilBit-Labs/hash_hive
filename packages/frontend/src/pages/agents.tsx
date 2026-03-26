import { useState } from 'react';
import { StatusBadge } from '../components/features/status-badge';
import { EmptyState } from '../components/ui/empty-state';
import { PageHeader } from '../components/ui/page-header';
import { Select } from '../components/ui/select';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table';
import { TextLink } from '../components/ui/text-link';
import { useAgents } from '../hooks/use-dashboard';
import { useUiStore } from '../stores/ui';

export function AgentsPage() {
  const { selectedProjectId } = useUiStore();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const { data, isLoading } = useAgents(statusFilter ? { status: statusFilter } : undefined);

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Agents</PageHeader>
        <EmptyState message="Select a project to view agents." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader>Agents</PageHeader>
        <Select
          className="w-auto px-3 py-1.5 text-xs"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="busy">Busy</option>
          <option value="error">Error</option>
        </Select>
      </div>

      {isLoading ? (
        <EmptyState message="Loading agents\u2026" />
      ) : !data?.agents.length ? (
        <EmptyState message="No agents found." />
      ) : (
        <Table>
          <TableHead>
            <tr>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th>Last Seen</Th>
              <Th>Actions</Th>
            </tr>
          </TableHead>
          <TableBody>
            {data.agents.map((agent) => (
              <TableRow key={agent.id}>
                <Td className="text-sm font-medium text-foreground">{agent.name}</Td>
                <Td>
                  <StatusBadge status={agent.status} />
                </Td>
                <Td className="text-xs text-muted-foreground">
                  {agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : 'Never'}
                </Td>
                <Td>
                  <TextLink to={`/agents/${agent.id}`}>Details</TextLink>
                </Td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
