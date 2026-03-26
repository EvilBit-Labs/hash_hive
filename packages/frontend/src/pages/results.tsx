import { useState } from 'react';
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
        <h2 className="text-xl font-semibold tracking-tight">Cracked Results</h2>
        <p className="text-sm text-muted-foreground">Select a project to view results.</p>
      </div>
    );
  }

  const total = data?.total ?? 0;
  const hasNext = offset + limit < total;
  const hasPrev = offset > 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Cracked Results</h2>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Search hashes or plaintexts\u2026"
            className="rounded border border-surface-0 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary/40"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
          {exportUrl && (
            <a
              href={exportUrl}
              download
              className="rounded border border-surface-0 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-surface-0/60 hover:text-foreground"
            >
              Export CSV
            </a>
          )}
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading results\u2026</p>
      ) : !data?.results.length ? (
        <p className="text-sm text-muted-foreground">No cracked results found.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-surface-0">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-surface-0 bg-surface-0/30">
                <tr>
                  <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Hash
                  </th>
                  <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Plaintext
                  </th>
                  <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Campaign
                  </th>
                  <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Hash List
                  </th>
                  <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Cracked At
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-0/50">
                {data.results.map((r) => (
                  <tr key={r.id} className="transition-colors hover:bg-surface-0/20">
                    <td className="max-w-[200px] truncate px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
                      {r.hashValue}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] font-medium text-success">
                      {r.plaintext ?? '\u2014'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{r.campaignName}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{r.hashListName}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {r.crackedAt ? new Date(r.crackedAt).toLocaleString() : '\u2014'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {offset + 1}\u2013{Math.min(offset + limit, total)} of {total}
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={!hasPrev}
                onClick={() => setOffset(Math.max(0, offset - limit))}
                className="rounded border border-surface-0 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-surface-0/60 hover:text-foreground disabled:opacity-30"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!hasNext}
                onClick={() => setOffset(offset + limit)}
                className="rounded border border-surface-0 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-surface-0/60 hover:text-foreground disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
