import { useState } from 'react';
import { Link } from 'react-router';
import { PermissionGuard } from '../components/features/permission-guard';
import { ResourceUploadModal } from '../components/features/resource-upload-modal';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { Input } from '../components/ui/input';
import { PageHeader } from '../components/ui/page-header';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table';
import {
  useGuessHashType,
  useHashLists,
  useMasklists,
  useRulelists,
  useWordlists,
} from '../hooks/use-resources';
import { Permission } from '../lib/permissions';
import { cn } from '../lib/utils';
import { useUiStore } from '../stores/ui';

type Tab = 'hash-lists' | 'wordlists' | 'rulelists' | 'masklists' | 'hash-detect';

type UploadableTab = 'hash-lists' | 'wordlists' | 'rulelists' | 'masklists';

export function ResourcesPage() {
  const { selectedProjectId } = useUiStore();
  const [activeTab, setActiveTab] = useState<Tab>('hash-lists');

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Resources</PageHeader>
        <EmptyState message="Select a project to view resources." />
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'hash-lists', label: 'Hash Lists' },
    { id: 'wordlists', label: 'Wordlists' },
    { id: 'rulelists', label: 'Rulelists' },
    { id: 'masklists', label: 'Masklists' },
    { id: 'hash-detect', label: 'Hash Detect' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader>Resources</PageHeader>

      <div className="flex gap-1 border-b border-surface-0/50">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'border-b-2 px-3 py-2 text-xs font-medium transition-colors',
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'hash-lists' && <HashListsTab />}
      {activeTab === 'wordlists' && <ResourceListTab type="wordlists" />}
      {activeTab === 'rulelists' && <ResourceListTab type="rulelists" />}
      {activeTab === 'masklists' && <ResourceListTab type="masklists" />}
      {activeTab === 'hash-detect' && <HashDetectTab />}
    </div>
  );
}

function UploadButton({ type }: { type: UploadableTab }) {
  const [open, setOpen] = useState(false);

  const labels: Record<UploadableTab, string> = {
    'hash-lists': 'Hash List',
    wordlists: 'Wordlist',
    rulelists: 'Rulelist',
    masklists: 'Masklist',
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Upload {labels[type]}
      </Button>
      <ResourceUploadModal
        type={type}
        open={open}
        onClose={() => setOpen(false)}
        onSuccess={() => {}}
      />
    </>
  );
}

function HashListsTab() {
  const { data, isLoading } = useHashLists();

  if (isLoading) return <EmptyState message="Loading\u2026" />;

  const hashLists = data?.hashLists ?? [];

  return (
    <div className="space-y-4">
      <PermissionGuard permission={Permission.RESOURCE_UPLOAD}>
        <div className="flex justify-end">
          <UploadButton type="hash-lists" />
        </div>
      </PermissionGuard>

      {hashLists.length === 0 ? (
        <EmptyState message="No hash lists found." />
      ) : (
        <Table>
          <TableHead>
            <tr>
              <Th>Name</Th>
              <Th>Hashes</Th>
              <Th>Cracked</Th>
              <Th>Progress</Th>
              <Th>Created</Th>
            </tr>
          </TableHead>
          <TableBody>
            {hashLists.map((hl) => {
              const pct = hl.hashCount > 0 ? (hl.crackedCount / hl.hashCount) * 100 : 0;
              return (
                <TableRow key={hl.id}>
                  <Td className="text-sm font-medium text-foreground">
                    <Link
                      to={`/resources/hash-lists/${hl.id}`}
                      className="hover:text-primary hover:underline"
                    >
                      {hl.name}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs tabular-nums">{hl.hashCount}</Td>
                  <Td className="font-mono text-xs tabular-nums text-success">{hl.crackedCount}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 rounded-full bg-surface-1">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                      </div>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {pct.toFixed(0)}%
                      </span>
                    </div>
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {new Date(hl.createdAt).toLocaleDateString()}
                  </Td>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function useResourcesByType(type: 'wordlists' | 'rulelists' | 'masklists') {
  const wordlists = useWordlists({ enabled: type === 'wordlists' });
  const rulelists = useRulelists({ enabled: type === 'rulelists' });
  const masklists = useMasklists({ enabled: type === 'masklists' });

  const hookMap = { wordlists, rulelists, masklists };
  return hookMap[type];
}

function ResourceListTab({ type }: { type: 'wordlists' | 'rulelists' | 'masklists' }) {
  const { data, isLoading } = useResourcesByType(type);

  if (isLoading) return <EmptyState message="Loading\u2026" />;

  const resources = data?.resources ?? [];

  return (
    <div className="space-y-4">
      <PermissionGuard permission={Permission.RESOURCE_UPLOAD}>
        <div className="flex justify-end">
          <UploadButton type={type} />
        </div>
      </PermissionGuard>

      {resources.length === 0 ? (
        <EmptyState message={`No ${type} found.`} />
      ) : (
        <Table>
          <TableHead>
            <tr>
              <Th>Name</Th>
              <Th>Created</Th>
            </tr>
          </TableHead>
          <TableBody>
            {resources.map((r) => (
              <TableRow key={r.id}>
                <Td className="text-sm font-medium text-foreground">{r.name}</Td>
                <Td className="text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleDateString()}
                </Td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function HashDetectTab() {
  const [hashInput, setHashInput] = useState('');
  const guessType = useGuessHashType();

  const handleDetect = () => {
    if (hashInput.trim()) {
      guessType.mutate(hashInput.trim());
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          placeholder="Paste a hash value\u2026"
          className="font-mono text-xs"
          value={hashInput}
          onChange={(e) => setHashInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleDetect();
          }}
        />
        <Button
          onClick={handleDetect}
          disabled={guessType.isPending || !hashInput.trim()}
          className="shrink-0"
        >
          {guessType.isPending ? 'Detecting\u2026' : 'Detect Type'}
        </Button>
      </div>

      {guessType.data && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">
            Results{' '}
            <span className="text-muted-foreground">
              ({guessType.data.identified ? 'Identified' : 'Candidates'})
            </span>
          </h3>
          {guessType.data.candidates.length === 0 ? (
            <EmptyState message="No matching hash types found." />
          ) : (
            <Table>
              <TableHead>
                <tr>
                  <Th>Type</Th>
                  <Th>Mode</Th>
                  <Th>Category</Th>
                  <Th>Confidence</Th>
                </tr>
              </TableHead>
              <TableBody>
                {guessType.data.candidates.map((c) => (
                  <TableRow key={c.hashcatMode}>
                    <Td className="text-sm font-medium text-foreground">{c.name}</Td>
                    <Td className="font-mono text-xs">{c.hashcatMode}</Td>
                    <Td className="text-xs text-muted-foreground">{c.category}</Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 rounded-full bg-surface-1">
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${Math.round(c.confidence * 100)}%` }}
                          />
                        </div>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {Math.round(c.confidence * 100)}%
                        </span>
                      </div>
                    </Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </div>
  );
}
