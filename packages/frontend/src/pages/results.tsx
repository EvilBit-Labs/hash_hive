import { useState } from 'react';
import { Button, buttonVariants } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { Input } from '../components/ui/input';
import { PageHeader } from '../components/ui/page-header';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table';
import { useResults, useResultsExportUrl } from '../hooks/use-results';
import { useUiStore } from '../stores/ui';

export function ResultsPage() {
  const { selectedProjectId } = useUiStore();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const { data, isLoading } = useResults({
    ...(search ? { search } : {}),
    limit,
    offset,
  });
  const exportUrl = useResultsExportUrl({
    ...(search ? { search } : {}),
  });

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Cracked Results</PageHeader>
        <EmptyState message="Select a project to view results." />
      </div>
    );
  }

  const total = data?.total ?? 0;
  const hasNext = offset + limit < total;
  const hasPrev = offset > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader>Cracked Results</PageHeader>
        <div className="flex gap-2">
          <Input
            aria-label="Search hashes or plaintexts"
            placeholder="Search hashes or plaintexts..."
            className="w-auto px-3 py-1.5 text-xs"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
          {exportUrl && (
            <a href={exportUrl} download className={buttonVariants('secondary', 'sm')}>
              Export CSV
            </a>
          )}
        </div>
      </div>

      <div aria-live="polite">
        {isLoading ? (
          <EmptyState message="Loading results..." />
        ) : !data?.results.length ? (
          <EmptyState message="No cracked results found." />
        ) : (
          <>
            <Table>
              <TableHead>
                <tr>
                  <Th>Hash</Th>
                  <Th>Plaintext</Th>
                  <Th>Campaign</Th>
                  <Th>Hash List</Th>
                  <Th>Cracked At</Th>
                </tr>
              </TableHead>
              <TableBody>
                {data.results.map((r) => (
                  <TableRow key={r.id}>
                    <Td className="max-w-[200px] truncate font-mono text-xs text-muted-foreground">
                      {r.hashValue}
                    </Td>
                    <Td className="font-mono text-xs font-medium text-success">
                      {r.plaintext ?? '-'}
                    </Td>
                    <Td className="text-xs text-muted-foreground">{r.campaignName}</Td>
                    <Td className="text-xs text-muted-foreground">{r.hashListName}</Td>
                    <Td className="text-xs text-muted-foreground">
                      {r.crackedAt ? new Date(r.crackedAt).toLocaleString() : '-'}
                    </Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {offset + 1}-{Math.min(offset + limit, total)} of {total}
              </span>
              <div className="flex gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!hasPrev}
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!hasNext}
                  onClick={() => setOffset(offset + limit)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
