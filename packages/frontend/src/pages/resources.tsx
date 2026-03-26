import { useState } from 'react';
import { ResourceUploadModal } from '../components/features/resource-upload-modal';
import {
  useGuessHashType,
  useHashLists,
  useMasklists,
  useRulelists,
  useWordlists,
} from '../hooks/use-resources';
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
        <h2 className="text-xl font-semibold tracking-tight">Resources</h2>
        <p className="text-sm text-muted-foreground">Select a project to view resources.</p>
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
    <div className="space-y-5">
      <h2 className="text-xl font-semibold tracking-tight">Resources</h2>

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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Upload {labels[type]}
      </button>
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

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading\u2026</p>;

  const hashLists = data?.hashLists ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <UploadButton type="hash-lists" />
      </div>

      {hashLists.length === 0 ? (
        <p className="text-sm text-muted-foreground">No hash lists found.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-surface-0">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-surface-0 bg-surface-0/30">
              <tr>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Name
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Hashes
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Cracked
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-0/50">
              {hashLists.map((hl) => (
                <tr key={hl.id} className="transition-colors hover:bg-surface-0/20">
                  <td className="px-4 py-2.5 text-sm font-medium text-foreground">{hl.name}</td>
                  <td className="px-4 py-2.5 font-mono text-xs tabular-nums">{hl.hashCount}</td>
                  <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-success">
                    {hl.crackedCount}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {new Date(hl.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ResourceListTab({ type }: { type: 'wordlists' | 'rulelists' | 'masklists' }) {
  const wordlists = useWordlists();
  const rulelists = useRulelists();
  const masklists = useMasklists();

  const hookMap = { wordlists, rulelists, masklists };
  const { data, isLoading } = hookMap[type];

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading\u2026</p>;

  const resources = data?.resources ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <UploadButton type={type} />
      </div>

      {resources.length === 0 ? (
        <p className="text-sm text-muted-foreground">No {type} found.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-surface-0">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-surface-0 bg-surface-0/30">
              <tr>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Name
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-0/50">
              {resources.map((r) => (
                <tr key={r.id} className="transition-colors hover:bg-surface-0/20">
                  <td className="px-4 py-2.5 text-sm font-medium text-foreground">{r.name}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
        <input
          type="text"
          placeholder="Paste a hash value\u2026"
          className="flex-1 rounded border border-surface-0 bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary/40"
          value={hashInput}
          onChange={(e) => setHashInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleDetect();
          }}
        />
        <button
          type="button"
          onClick={handleDetect}
          disabled={guessType.isPending || !hashInput.trim()}
          className="rounded bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {guessType.isPending ? 'Detecting\u2026' : 'Detect Type'}
        </button>
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
            <p className="text-sm text-muted-foreground">No matching hash types found.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-surface-0">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-surface-0 bg-surface-0/30">
                  <tr>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Type
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Mode
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Category
                    </th>
                    <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Confidence
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-0/50">
                  {guessType.data.candidates.map((c) => (
                    <tr key={c.hashcatMode} className="transition-colors hover:bg-surface-0/20">
                      <td className="px-4 py-2.5 text-sm font-medium text-foreground">{c.name}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{c.hashcatMode}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{c.category}</td>
                      <td className="px-4 py-2.5">
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
