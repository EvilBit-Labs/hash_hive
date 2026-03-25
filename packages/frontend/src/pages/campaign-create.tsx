import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Resolver, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import ReactFlow, {
  Background,
  Controls,
  type Edge,
  type Node as FlowNode,
  type OnConnect,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { z } from 'zod';
import { ResourceUploadModal } from '../components/features/resource-upload-modal';
import { StatusBadge } from '../components/features/status-badge';
import { useCreateCampaign } from '../hooks/use-campaigns';
import { useHashLists, useMasklists, useRulelists, useWordlists } from '../hooks/use-resources';
import { ApiError, api } from '../lib/api';
import { validateDAG } from '../lib/dag-validation';
import { useCampaignWizard } from '../stores/campaign-wizard';
import { useUiStore } from '../stores/ui';

const STEPS = ['Basic Info', 'Attacks', 'Review'];

const basicInfoSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().max(2000).optional(),
  priority: z.coerce.number().int().min(1).max(10),
  hashListId: z.coerce.number().int().positive('Hash list is required'),
});

type BasicInfoForm = z.infer<typeof basicInfoSchema>;

const optionalResourceId = z.preprocess(
  (val) => (val === '' || val === null ? undefined : val),
  z.coerce.number().int().positive().optional()
);

const attackSchema = z.object({
  mode: z.coerce.number().int().nonnegative('Mode is required'),
  wordlistId: optionalResourceId,
  rulelistId: optionalResourceId,
  masklistId: optionalResourceId,
});

interface AttackForm {
  mode: number;
  wordlistId?: number;
  rulelistId?: number;
  masklistId?: number;
}

type UploadModalType = 'hash-lists' | 'wordlists' | 'rulelists' | 'masklists';

function buildNodes(attacks: readonly { mode: number }[]): FlowNode[] {
  return attacks.map((attack, i) => ({
    id: String(i),
    type: 'default',
    position: { x: (i % 4) * 200, y: Math.floor(i / 4) * 120 },
    data: { label: `#${i} Mode ${attack.mode}` },
  }));
}

function buildEdges(attacks: readonly { dependencies: number[] }[]): Edge[] {
  return attacks.flatMap((attack, i) =>
    attack.dependencies.map((depIdx) => ({
      id: `e${depIdx}-${i}`,
      source: String(depIdx),
      target: String(i),
      animated: false,
    }))
  );
}

export function CampaignCreatePage() {
  const { selectedProjectId } = useUiStore();
  const wizard = useCampaignWizard();
  const navigate = useNavigate();
  const createCampaign = useCreateCampaign();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadModal, setUploadModal] = useState<{
    open: boolean;
    type: UploadModalType;
  }>({ open: false, type: 'hash-lists' });

  // Resource queries for dropdowns
  const hashListsQuery = useHashLists();
  const wordlistsQuery = useWordlists();
  const rulelistsQuery = useRulelists();
  const masklistsQuery = useMasklists();

  // DAG validation — runs on every attacks change
  const dagValidation = useMemo(() => validateDAG(wizard.attacks), [wizard.attacks]);

  // React Flow state for Step 2
  const [nodes, setNodes, onNodesChange] = useNodesState(buildNodes(wizard.attacks));
  const [edges, setEdges, onEdgesChange] = useEdgesState(buildEdges(wizard.attacks));

  // Sync React Flow state when attacks change
  useEffect(() => {
    setNodes(buildNodes(wizard.attacks));
    setEdges(buildEdges(wizard.attacks));
  }, [wizard.attacks, setNodes, setEdges]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset wizard state on unmount only
  useEffect(() => {
    return () => wizard.reset();
  }, []);

  const basicInfoForm = useForm<BasicInfoForm>({
    // z.coerce widens input type; cast is safe since output matches BasicInfoForm
    resolver: zodResolver(basicInfoSchema) as unknown as Resolver<BasicInfoForm>,
    defaultValues: {
      name: wizard.name,
      priority: wizard.priority,
      ...(wizard.description ? { description: wizard.description } : {}),
      ...(wizard.hashListId ? { hashListId: wizard.hashListId } : {}),
    },
  });

  const attackForm = useForm<AttackForm>({
    // z.preprocess widens input type to unknown; cast is safe since output matches AttackForm
    resolver: zodResolver(attackSchema) as unknown as Resolver<AttackForm>,
  });

  const handleConnect: OnConnect = useCallback(
    (connection) => {
      const sourceIdx = Number(connection.source);
      const targetIdx = Number(connection.target);
      if (!Number.isNaN(sourceIdx) && !Number.isNaN(targetIdx)) {
        // Dependency direction: edge from source → target means target depends on source
        wizard.addDependency(targetIdx, sourceIdx);
      }
    },
    [wizard]
  );

  const handleEdgeDelete = useCallback(
    (edgesToDelete: Edge[]) => {
      for (const edge of edgesToDelete) {
        const sourceIdx = Number(edge.source);
        const targetIdx = Number(edge.target);
        if (!Number.isNaN(sourceIdx) && !Number.isNaN(targetIdx)) {
          wizard.removeDependency(targetIdx, sourceIdx);
        }
      }
    },
    [wizard]
  );

  if (!selectedProjectId) {
    return <p className="text-muted-foreground">Select a project first.</p>;
  }

  const onBasicInfoSubmit = basicInfoForm.handleSubmit((data) => {
    wizard.setBasicInfo({
      name: data['name'],
      description: data['description'] ?? '',
      priority: data['priority'],
    });
    wizard.setHashListId(data['hashListId']);
    wizard.setStep(1);
  });

  const handleAddAttack = (data: AttackForm) => {
    wizard.addAttack({
      mode: data.mode,
      ...(data.wordlistId ? { wordlistId: data.wordlistId } : {}),
      ...(data.rulelistId ? { rulelistId: data.rulelistId } : {}),
      ...(data.masklistId ? { masklistId: data.masklistId } : {}),
      dependencies: [],
    });
    attackForm.reset();
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await createCampaign.mutateAsync({
        name: wizard.name,
        hashListId: wizard.hashListId ?? 0,
        priority: wizard.priority,
        ...(wizard.description ? { description: wizard.description } : {}),
      });

      const campaignId = result.campaign.id;

      // Create attacks sequentially using direct API calls to avoid stale hook state
      for (const attack of wizard.attacks) {
        await api.post(`/dashboard/campaigns/${campaignId}/attacks`, {
          ...attack,
          ...(attack.dependencies.length > 0 ? { dependencies: attack.dependencies } : {}),
        });
      }

      wizard.reset();
      navigate(`/campaigns/${campaignId}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to create campaign');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const hashLists = hashListsQuery.data?.hashLists ?? [];
  const wordlists = wordlistsQuery.data?.resources ?? [];
  const rulelists = rulelistsQuery.data?.resources ?? [];
  const masklists = masklistsQuery.data?.resources ?? [];

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Create Campaign</h2>

      {/* Step indicator */}
      <div className="flex gap-2">
        {STEPS.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              if (i < wizard.step) wizard.setStep(i);
            }}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              i === wizard.step
                ? 'bg-primary text-primary-foreground'
                : i < wizard.step
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-muted text-muted-foreground'
            }`}
          >
            {i + 1}. {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      {/* Step 0: Basic Info */}
      {wizard.step === 0 && (
        <form onSubmit={onBasicInfoSubmit} className="space-y-4">
          <div>
            <label htmlFor="name" className="text-sm font-medium">
              Campaign Name
            </label>
            <input
              id="name"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              {...basicInfoForm.register('name')}
            />
            {basicInfoForm.formState.errors.name && (
              <p className="mt-1 text-xs text-destructive">
                {basicInfoForm.formState.errors.name.message}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="description" className="text-sm font-medium">
              Description
            </label>
            <textarea
              id="description"
              rows={3}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              {...basicInfoForm.register('description')}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="priority" className="text-sm font-medium">
                Priority (1-10)
              </label>
              <input
                id="priority"
                type="number"
                min={1}
                max={10}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                {...basicInfoForm.register('priority')}
              />
            </div>
            <div>
              <label htmlFor="hashListId" className="text-sm font-medium">
                Hash List
              </label>
              <div className="mt-1 flex gap-2">
                <select
                  id="hashListId"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  {...basicInfoForm.register('hashListId')}
                >
                  <option value="">Select a hash list...</option>
                  {hashLists.map((hl) => (
                    <option key={hl.id} value={hl.id}>
                      {hl.name} ({hl.hashCount} hashes)
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setUploadModal({ open: true, type: 'hash-lists' })}
                  className="shrink-0 rounded-md border px-3 py-2 text-sm hover:bg-accent"
                >
                  Upload New
                </button>
              </div>
              {basicInfoForm.formState.errors.hashListId && (
                <p className="mt-1 text-xs text-destructive">
                  {basicInfoForm.formState.errors.hashListId.message}
                </p>
              )}
            </div>
          </div>

          <button
            type="submit"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Next: Configure Attacks
          </button>
        </form>
      )}

      {/* Step 1: Attacks */}
      {wizard.step === 1 && (
        <div className="space-y-4">
          <div className="flex gap-6">
            {/* Left column: Attack configuration form */}
            <div className="w-2/5 space-y-4">
              <form onSubmit={attackForm.handleSubmit(handleAddAttack)} className="space-y-3">
                <h3 className="font-medium">Add Attack</h3>
                <div className="space-y-3">
                  <div>
                    <label htmlFor="mode" className="text-xs font-medium">
                      Hashcat Mode
                    </label>
                    <input
                      id="mode"
                      type="number"
                      className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                      {...attackForm.register('mode')}
                    />
                  </div>
                  <div>
                    <label htmlFor="wordlistId" className="text-xs font-medium">
                      Wordlist
                    </label>
                    <div className="mt-1 flex gap-2">
                      <select
                        id="wordlistId"
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        {...attackForm.register('wordlistId')}
                      >
                        <option value="">None</option>
                        {wordlists.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setUploadModal({ open: true, type: 'wordlists' })}
                        className="shrink-0 rounded-md border px-2 py-1 text-xs hover:bg-accent"
                      >
                        Upload
                      </button>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="rulelistId" className="text-xs font-medium">
                      Rulelist
                    </label>
                    <div className="mt-1 flex gap-2">
                      <select
                        id="rulelistId"
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        {...attackForm.register('rulelistId')}
                      >
                        <option value="">None</option>
                        {rulelists.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setUploadModal({ open: true, type: 'rulelists' })}
                        className="shrink-0 rounded-md border px-2 py-1 text-xs hover:bg-accent"
                      >
                        Upload
                      </button>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="masklistId" className="text-xs font-medium">
                      Masklist
                    </label>
                    <div className="mt-1 flex gap-2">
                      <select
                        id="masklistId"
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        {...attackForm.register('masklistId')}
                      >
                        <option value="">None</option>
                        {masklists.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setUploadModal({ open: true, type: 'masklists' })}
                        className="shrink-0 rounded-md border px-2 py-1 text-xs hover:bg-accent"
                      >
                        Upload
                      </button>
                    </div>
                  </div>
                </div>
                <button
                  type="submit"
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                >
                  Add Attack
                </button>
              </form>

              {/* Attack list */}
              {wizard.attacks.length > 0 && (
                <div className="space-y-2">
                  <h3 className="font-medium">Configured Attacks</h3>
                  {wizard.attacks.map((attack, i) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: attacks have no stable ID before creation
                      key={i}
                      className="flex items-center justify-between rounded-md border p-3"
                    >
                      <div className="text-sm">
                        <span className="font-medium">
                          #{i} Mode {attack.mode}
                        </span>
                        {attack.wordlistId && (
                          <span className="ml-2 text-muted-foreground">
                            Wordlist #{attack.wordlistId}
                          </span>
                        )}
                        {attack.rulelistId && (
                          <span className="ml-2 text-muted-foreground">
                            Rulelist #{attack.rulelistId}
                          </span>
                        )}
                        {attack.dependencies.length > 0 && (
                          <span className="ml-2 text-muted-foreground">
                            Deps: [{attack.dependencies.join(', ')}]
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => wizard.removeAttack(i)}
                        className="text-xs text-destructive hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Right column: React Flow DAG editor */}
            <div className="w-3/5 space-y-2">
              <h3 className="font-medium">Dependency Graph</h3>
              <p className="text-xs text-muted-foreground">
                Drag edges between attacks to set dependencies. Arrow from A → B means B depends on
                A.
              </p>
              {!dagValidation.valid && (
                <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                  Circular dependency detected between attacks: [{dagValidation.cycle?.join(', ')}]
                </div>
              )}
              <div className="h-[400px] rounded-md border">
                {wizard.attacks.length > 0 ? (
                  <ReactFlow
                    nodes={nodes}
                    edges={
                      dagValidation.valid
                        ? edges
                        : edges.map((e) => {
                            const sourceIdx = Number(e.source);
                            const targetIdx = Number(e.target);
                            const inCycle =
                              dagValidation.cycle?.includes(sourceIdx) &&
                              dagValidation.cycle?.includes(targetIdx);
                            return inCycle
                              ? { ...e, style: { stroke: '#ef4444', strokeWidth: 2 } }
                              : e;
                          })
                    }
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={handleConnect}
                    onEdgesDelete={handleEdgeDelete}
                    fitView
                    deleteKeyCode="Backspace"
                  >
                    <Background />
                    <Controls />
                  </ReactFlow>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Add attacks to see the dependency graph
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => wizard.setStep(0)}
              className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => wizard.setStep(2)}
              disabled={wizard.attacks.length === 0 || !dagValidation.valid}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Next: Review
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Review & Submit */}
      {wizard.step === 2 && (
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 font-medium">Campaign Summary</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Name</dt>
                <dd>{wizard.name}</dd>
              </div>
              {wizard.description && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Description</dt>
                  <dd className="max-w-xs truncate">{wizard.description}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Priority</dt>
                <dd>{wizard.priority}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Hash List</dt>
                <dd>#{wizard.hashListId}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Attacks</dt>
                <dd>
                  <StatusBadge status={`${wizard.attacks.length} configured`} />
                </dd>
              </div>
            </dl>
          </div>

          {/* DAG Preview — read-only visualization */}
          {wizard.attacks.length > 0 && (
            <div className="rounded-lg border bg-card p-4">
              <h3 className="mb-3 font-medium">DAG Preview</h3>
              <div className="h-[300px]">
                <ReactFlow
                  nodes={buildNodes(wizard.attacks)}
                  edges={buildEdges(wizard.attacks)}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  fitView
                >
                  <Background />
                </ReactFlow>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => wizard.setStep(1)}
              className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
            >
              Back
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Campaign'}
            </button>
          </div>
        </div>
      )}

      {/* Resource upload modal */}
      <ResourceUploadModal
        type={uploadModal.type}
        open={uploadModal.open}
        onClose={() => setUploadModal((prev) => ({ ...prev, open: false }))}
        onSuccess={(resourceId) => {
          if (uploadModal.type === 'hash-lists') {
            basicInfoForm.setValue('hashListId', resourceId);
          } else if (uploadModal.type === 'wordlists') {
            attackForm.setValue('wordlistId', resourceId);
          } else if (uploadModal.type === 'rulelists') {
            attackForm.setValue('rulelistId', resourceId);
          } else if (uploadModal.type === 'masklists') {
            attackForm.setValue('masklistId', resourceId);
          }
        }}
      />
    </div>
  );
}
