import { useState } from 'react';
import { useParams } from 'react-router';
import { StatusBadge } from '../components/features/status-badge';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { ErrorBanner } from '../components/ui/error-banner';
import { Input } from '../components/ui/input';
import { PageHeader } from '../components/ui/page-header';
import { Select } from '../components/ui/select';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table';
import { TextLink } from '../components/ui/text-link';
import { useHashListDetail, useHashListItems } from '../hooks/use-resources';

type StatusFilter = 'all' | 'cracked' | 'uncracked';

const PAGE_SIZE = 50;

export function HashListDetailPage() {
  const { id } = useParams<{ id: string }>();
  const hashListId = Number(id);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  const { data, isLoading, isError, error } = useHashListDetail(hashListId);
  const { data: itemsData, isLoading: itemsLoading } = useHashListItems(hashListId, {
    status: statusFilter,
    ...(search ? { search } : {}),
    limit: PAGE_SIZE,
    offset,
  });

  if (isLoading) return <EmptyState message="Loading hash list\u2026" />;

  if (isError) {
    return (
      <div className="space-y-4">
        <TextLink to="/resources">&larr; Back to resources</TextLink>
        <ErrorBanner
          message={error instanceof Error ? error.message : 'Failed to load hash list'}
        />
      </div>
    );
  }

  if (!data?.hashList) {
    return (
      <div className="space-y-4">
        <TextLink to="/resources">&larr; Back to resources</TextLink>
        <EmptyState message="Hash list not found." />
      </div>
    );
  }

  const { hashList } = data;
  const stats = hashList.statistics;
  const percentage = stats.total > 0 ? (stats.cracked / stats.total) * 100 : 0;
  const items = itemsData?.items ?? [];
  const total = itemsData?.total ?? 0;
  const hasNext = offset + PAGE_SIZE < total;
  const hasPrev = offset > 0;

  return (
    <div className="space-y-6">
      <TextLink to="/resources">&larr; Back to resources</TextLink>

      <div className="flex items-center gap-3">
        <PageHeader>{hashList.name}</PageHeader>
        <StatusBadge status={hashList.status} />
      </div>

      {/* Statistics cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total" value={stats.total.toLocaleString()} />
        <StatCard label="Cracked" value={stats.cracked.toLocaleString()} className="text-success" />
        <StatCard label="Remaining" value={stats.remaining.toLocaleString()} />
        <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Progress
          </p>
          <p className="mt-2 font-mono text-2xl font-bold tabular-nums">{percentage.toFixed(1)}%</p>
          <div className="mt-2 h-1.5 w-full rounded-full bg-surface-1">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.min(percentage, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <Select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as StatusFilter);
            setOffset(0);
          }}
        >
          <option value="all">All</option>
          <option value="cracked">Cracked</option>
          <option value="uncracked">Uncracked</option>
        </Select>
        <Input
          placeholder="Search hashes\u2026"
          className="max-w-xs font-mono text-xs"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
      </div>

      {/* Hash items table */}
      {itemsLoading ? (
        <EmptyState message="Loading hashes\u2026" />
      ) : items.length === 0 ? (
        <EmptyState message="No hashes match your filters." />
      ) : (
        <>
          <Table>
            <TableHead>
              <tr>
                <Th>Hash Value</Th>
                <Th>Status</Th>
                <Th>Plaintext</Th>
                <Th>Cracked At</Th>
                <Th>Agent</Th>
              </tr>
            </TableHead>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <Td className="max-w-[300px] truncate font-mono text-xs">{item.hashValue}</Td>
                  <Td>
                    <StatusBadge status={item.crackedAt ? 'cracked' : 'uncracked'} />
                  </Td>
                  <Td className="font-mono text-xs text-success">{item.plaintext ?? '\u2014'}</Td>
                  <Td className="text-xs text-muted-foreground">
                    {item.crackedAt ? new Date(item.crackedAt).toLocaleString() : '\u2014'}
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">
                    {item.agentId ? `#${item.agentId}` : '\u2014'}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {offset + 1}\u2013{Math.min(offset + PAGE_SIZE, total)} of{' '}
              {total.toLocaleString()}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={!hasPrev}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!hasNext}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-bold tabular-nums ${className ?? ''}`}>{value}</p>
    </div>
  );
}
