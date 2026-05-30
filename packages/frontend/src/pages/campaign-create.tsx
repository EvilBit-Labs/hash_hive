import type { Edge, Node as FlowNode, OnConnect } from 'reactflow'

import { zodResolver } from '@hookform/resolvers/zod'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Resolver, useForm } from 'react-hook-form'
import { Navigate, useNavigate } from 'react-router'
import ReactFlow, { Background, useEdgesState, useNodesState } from 'reactflow'

import {
  AttackDagEditor,
  AttackList,
  type BasicInfoForm,
  BasicInfoStep,
  basicInfoSchema,
  TemplatePickerOverlay,
} from '../components/features/campaign-wizard'
import { ResourceUploadModal } from '../components/features/resource-upload-modal'
import { StatusBadge } from '../components/features/status-badge'
import { Button } from '../components/ui/button'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { PageHeader } from '../components/ui/page-header'
import { Select } from '../components/ui/select'
import { useAttackTemplates, useInstantiateAttackTemplate } from '../hooks/use-attack-templates'
import { useCreateCampaign } from '../hooks/use-campaigns'
import { usePermissions } from '../hooks/use-permissions'
import {
  useHashLists,
  useHashTypes,
  useMasklists,
  useRulelists,
  useWordlists,
} from '../hooks/use-resources'
import { ApiError, api } from '../lib/api'
import { ATTACK_MODES, attackModeLabel } from '../lib/attack-modes'
import {
  type AttackFormInput,
  type AttackFormOutput,
  attackFormSchema,
} from '../lib/attack-schemas'
import { topologicalOrder, validateDAG } from '../lib/dag-validation'
import { Permission } from '../lib/permissions'
import 'reactflow/dist/style.css'

import { cn } from '../lib/utils'
import { useCampaignWizard } from '../stores/campaign-wizard'
import { useUiStore } from '../stores/ui'

const STEPS = ['Basic Info', 'Attacks', 'Review']

type UploadModalType = 'hash-lists' | 'wordlists' | 'rulelists' | 'masklists'

function buildNodes(attacks: readonly { mode: number }[]): FlowNode[] {
  return attacks.map((attack, i) => ({
    id: String(i),
    type: 'default',
    position: { x: (i % 4) * 200, y: Math.floor(i / 4) * 120 },
    data: { label: `#${i} ${attackModeLabel(attack.mode)}` },
  }))
}

function buildEdges(attacks: readonly { dependencies: number[] }[]): Edge[] {
  return attacks.flatMap((attack, i) =>
    attack.dependencies.map((depIdx) => ({
      id: `e${depIdx}-${i}`,
      source: String(depIdx),
      target: String(i),
      animated: false,
    }))
  )
}

function stepIndicatorStyle(index: number, currentStep: number): string {
  if (index === currentStep) return 'bg-primary text-primary-foreground'
  if (index < currentStep) return 'bg-surface-0 text-foreground'
  return 'bg-surface-0/40 text-muted-foreground'
}

export function CampaignCreatePage() {
  const { can } = usePermissions()
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const wizard = useCampaignWizard()
  const navigate = useNavigate()
  const createCampaign = useCreateCampaign()
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [uploadModal, setUploadModal] = useState<{
    open: boolean
    type: UploadModalType
  }>({ open: false, type: 'hash-lists' })
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const instantiateTemplate = useInstantiateAttackTemplate()
  const { data: templatesData } = useAttackTemplates()

  const hashListsQuery = useHashLists()
  const hashTypesQuery = useHashTypes()
  const wordlistsQuery = useWordlists()
  const rulelistsQuery = useRulelists()
  const masklistsQuery = useMasklists()

  const dagValidation = useMemo(() => validateDAG(wizard.attacks), [wizard.attacks])

  const [nodes, setNodes, onNodesChange] = useNodesState(buildNodes(wizard.attacks))
  const [edges, setEdges, onEdgesChange] = useEdgesState(buildEdges(wizard.attacks))

  // Sync React Flow state when attacks change.
  //
  // Position preservation is keyed by React Flow node id (= wizard index).
  // That key is stable only when the array is appended to or updated in
  // place. `removeAttack` shifts every index above the removed one down by
  // one, so a stored position for id="2" would silently apply to the
  // attack that used to be at index 3 — a misassignment that the user
  // sees as nodes jumping into the wrong spot. Detect length decrease and
  // reset to the grid layout instead. (A stable per-attack uiId would
  // preserve positions across removes too, but that requires plumbing a
  // wizard-only field through the AttackConfig / store / submit path; the
  // length-based reset is correct and minimal.)
  const prevAttacksLengthRef = useRef(wizard.attacks.length)
  useEffect(() => {
    const prevLen = prevAttacksLengthRef.current
    const newLen = wizard.attacks.length
    prevAttacksLengthRef.current = newLen

    setNodes((prev) => {
      if (newLen < prevLen) {
        // remove: reset positions
        return buildNodes(wizard.attacks)
      }
      // add or update: preserve existing positions
      const prevPositions = new Map(prev.map((n) => [n.id, n.position]))
      return buildNodes(wizard.attacks).map((n) => {
        const previous = prevPositions.get(n.id)
        return previous ? { ...n, position: previous } : n
      })
    })
    setEdges(buildEdges(wizard.attacks))
  }, [wizard.attacks, setNodes, setEdges])

  // Cleanup wizard on real unmount only. The `mountedRef` + microtask guard
  // absorbs the React 18 Strict Mode double-invoke (mount -> cleanup -> mount)
  // so any pre-seeded store state survives the dev discard.
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      if (mountedRef.current) {
        mountedRef.current = false
        queueMicrotask(() => {
          if (!mountedRef.current) wizard.reset()
        })
      }
    }
    // oxlint-disable-next-line react/exhaustive-deps -- cleanup-only effect
  }, [])

  const basicInfoForm = useForm<BasicInfoForm>({
    resolver: zodResolver(basicInfoSchema) as unknown as Resolver<BasicInfoForm>,
    defaultValues: {
      name: wizard.name,
      priority: wizard.priority,
      ...(wizard.description ? { description: wizard.description } : {}),
      ...(wizard.hashListId ? { hashListId: wizard.hashListId } : {}),
    },
  })

  // Form-bound type is z.input (string textarea); resolver narrows to z.output
  // on submit (parsed object). The third generic on useForm carries the
  // transformed shape so `handleSubmit(handleAttackSubmit)` type-checks
  // without an `as never` cast in the JSX. The resolver cast remains
  // because z.preprocess widens zodResolver's input type to unknown.
  const attackForm = useForm<AttackFormInput, unknown, AttackFormOutput>({
    resolver: zodResolver(attackFormSchema) as unknown as Resolver<
      AttackFormInput,
      unknown,
      AttackFormOutput
    >,
  })

  // Prefill hash type from the selected hash list when starting a fresh attack.
  // Skips when editing an existing attack (the user's stored choice wins) and
  // when the user has already touched the hashTypeId field manually — without
  // the touched guard, a background refetch of useHashLists would silently
  // overwrite the user's explicit selection.
  const selectedHashList = hashListsQuery.data?.hashLists?.find((h) => h.id === wizard.hashListId)
  const detectedHashTypeId = selectedHashList?.hashTypeId ?? null
  useEffect(() => {
    if (detectedHashTypeId == null || editingIndex != null) return
    if (attackForm.formState.touchedFields['hashTypeId']) return
    attackForm.setValue('hashTypeId', detectedHashTypeId)
    // oxlint-disable-next-line react/exhaustive-deps -- attackForm identity is stable
  }, [detectedHashTypeId, editingIndex])

  const clearEdit = useCallback(() => {
    setEditingIndex(null)
    // Re-seed the prefilled hash type for the next fresh add (same reason
    // as in handleAttackSubmit's add branch — the prefill effect only
    // re-fires when its deps change, so the reset must carry the prefill
    // explicitly).
    attackForm.reset({
      mode: 0,
      ...(detectedHashTypeId != null ? { hashTypeId: detectedHashTypeId } : {}),
    })
  }, [attackForm, detectedHashTypeId])

  const seedFormFromAttack = useCallback(
    (idx: number) => {
      const attack = wizard.attacks[idx]
      if (!attack) return
      attackForm.reset({
        mode: attack.mode,
        ...(attack.hashTypeId != null ? { hashTypeId: attack.hashTypeId } : {}),
        ...(attack.wordlistId != null ? { wordlistId: attack.wordlistId } : {}),
        ...(attack.rulelistId != null ? { rulelistId: attack.rulelistId } : {}),
        ...(attack.masklistId != null ? { masklistId: attack.masklistId } : {}),
        ...(attack.advancedConfiguration
          ? { advancedConfiguration: JSON.stringify(attack.advancedConfiguration, null, 2) }
          : {}),
      })
      setEditingIndex(idx)
    },
    [attackForm, wizard.attacks]
  )

  const handleRemoveAttack = useCallback(
    (idx: number) => {
      wizard.removeAttack(idx)
      if (editingIndex === idx) {
        clearEdit()
      } else if (editingIndex != null && editingIndex > idx) {
        setEditingIndex(editingIndex - 1)
      }
    },
    [wizard, editingIndex, clearEdit]
  )

  const handleNodeClick = useCallback(
    (_event: unknown, node: { id: string }) => {
      const idx = Number(node.id)
      if (!Number.isNaN(idx)) seedFormFromAttack(idx)
    },
    [seedFormFromAttack]
  )

  const handleNodeContextMenu = useCallback(
    (event: { preventDefault: () => void }, node: { id: string }) => {
      event.preventDefault()
      const idx = Number(node.id)
      if (!Number.isNaN(idx)) handleRemoveAttack(idx)
    },
    [handleRemoveAttack]
  )

  const handleConnect: OnConnect = useCallback(
    (connection) => {
      const sourceIdx = Number(connection.source)
      const targetIdx = Number(connection.target)
      if (!Number.isNaN(sourceIdx) && !Number.isNaN(targetIdx)) {
        // Edge from source -> target means target depends on source.
        wizard.addDependency(targetIdx, sourceIdx)
      }
    },
    [wizard]
  )

  const handleEdgeDelete = useCallback(
    (edgesToDelete: Edge[]) => {
      for (const edge of edgesToDelete) {
        const sourceIdx = Number(edge.source)
        const targetIdx = Number(edge.target)
        if (!Number.isNaN(sourceIdx) && !Number.isNaN(targetIdx)) {
          wizard.removeDependency(targetIdx, sourceIdx)
        }
      }
    },
    [wizard]
  )

  if (!can(Permission.CAMPAIGN_CREATE)) {
    return <Navigate to="/campaigns" replace />
  }
  if (!selectedProjectId) {
    return <EmptyState message="Select a project first." />
  }

  const onBasicInfoSubmit = basicInfoForm.handleSubmit((data) => {
    wizard.setBasicInfo({
      name: data['name'],
      description: data['description'] ?? '',
      priority: data['priority'],
    })
    wizard.setHashListId(data['hashListId'])
    wizard.setStep(1)
  })

  const handleAttackSubmit = (data: AttackFormOutput) => {
    // Use `!= null` for hashTypeId so a future schema change that admits a
    // zero-valued id doesn't silently drop it. `hash_types.id` is a serial
    // primary key today (always positive in production), but truthy checks
    // also drop NaN — and `data.hashTypeId` is the resolver's coerced
    // output, where a coerce failure would surface as NaN rather than
    // undefined. `!= null` rejects both null and undefined explicitly. For
    // advancedConfiguration, `!== undefined` matches the resolver's
    // transform contract: it returns undefined when the textarea is empty
    // and the parsed object otherwise — which includes `{}`, a value that
    // would be dropped by a truthy check. Resource IDs stay truthy-checked
    // because the wire schema enforces positive integers.
    const payload = {
      mode: data.mode,
      ...(data.hashTypeId != null ? { hashTypeId: data.hashTypeId } : {}),
      ...(data.wordlistId ? { wordlistId: data.wordlistId } : {}),
      ...(data.rulelistId ? { rulelistId: data.rulelistId } : {}),
      ...(data.masklistId ? { masklistId: data.masklistId } : {}),
      ...(data.advancedConfiguration !== undefined
        ? { advancedConfiguration: data.advancedConfiguration }
        : {}),
    }
    if (editingIndex != null) {
      const existing = wizard.attacks[editingIndex]
      wizard.updateAttack(editingIndex, {
        ...payload,
        dependencies: existing?.dependencies ?? [],
      })
      clearEdit()
    } else {
      wizard.addAttack({ ...payload, dependencies: [] })
      // Re-seed the prefilled hash type on the next-attack form. The prefill
      // effect above only fires when `detectedHashTypeId` itself changes, so
      // a plain `reset({ mode: 0 })` would leave the second and later fresh
      // adds with no hash type. Inlining the prefill keeps subsequent attacks
      // in sync with the basic-info hash list.
      attackForm.reset({
        mode: 0,
        ...(detectedHashTypeId != null ? { hashTypeId: detectedHashTypeId } : {}),
      })
    }
  }

  const handleSubmit = async () => {
    setError(null)

    // Pre-flight: refuse to start the submit if a cycle exists OR if a
    // required field is missing. Computed outside the try/finally so
    // `submitting` stays false (the button does not flicker
    // disabled-then-enabled on a no-op press) and so we never POST a
    // sentinel `hashListId: 0` to the backend (the schema requires a
    // positive id; relying on the backend to reject 0 hides the bug).
    const topo = topologicalOrder(wizard.attacks)
    if (!topo.ok) {
      setError('Cannot create campaign while a dependency cycle exists.')
      return
    }
    if (wizard.hashListId == null) {
      setError('Select a hash list before creating the campaign.')
      return
    }
    const order = topo.order
    const hashListId = wizard.hashListId

    setSubmitting(true)
    let campaignId: number | null = null
    try {
      const result = await createCampaign.mutateAsync({
        name: wizard.name,
        hashListId,
        priority: wizard.priority,
        ...(wizard.description ? { description: wizard.description } : {}),
      })
      campaignId = result.campaign.id

      // Clone the attacks list. The store currently replaces the array
      // immutably on every edit, so a reference snapshot would also be
      // stable today, but a clone is cheap insurance against a future
      // store refactor that introduces in-place mutation.
      const attacksSnapshot = [...wizard.attacks]
      const createdIds = new Map<number, number>()

      // Create attacks in topological order so dependency IDs are known.
      // Build each POST body explicitly to keep wizard-internal fields out
      // of the wire shape — never spread the full attack object.
      for (const idx of order) {
        const attack = attacksSnapshot[idx]
        if (!attack) {
          throw new Error(
            `Internal error: topological order referenced attack #${idx} missing from snapshot.`
          )
        }
        const remappedDeps = attack.dependencies.map((depIdx) => {
          const id = createdIds.get(depIdx)
          if (id == null) {
            throw new Error(
              `Internal error: attack #${idx} depends on #${depIdx} which was not created.`
            )
          }
          return id
        })
        const body: Record<string, unknown> = { mode: attack.mode }
        if (attack.hashTypeId != null) body['hashTypeId'] = attack.hashTypeId
        if (attack.wordlistId != null) body['wordlistId'] = attack.wordlistId
        if (attack.rulelistId != null) body['rulelistId'] = attack.rulelistId
        if (attack.masklistId != null) body['masklistId'] = attack.masklistId
        if (attack.advancedConfiguration !== undefined) {
          body['advancedConfiguration'] = attack.advancedConfiguration
        }
        if (remappedDeps.length > 0) body['dependencies'] = remappedDeps
        const { attack: created } = await api.post<{ attack: { id: number } }>(
          `/dashboard/campaigns/${campaignId}/attacks`,
          body
        )
        createdIds.set(idx, created.id)
      }

      wizard.reset()
      void navigate(`/campaigns/${campaignId}`)
    } catch (err) {
      // oxlint-disable-next-line no-console -- log raw error for debugging before mapping
      console.error('[campaign-create] submit failed', err)

      // Compensating delete: a campaign was created but at least one attack
      // POST failed. Without this, retrying the wizard would create a
      // duplicate campaign and leave the partial one behind. Best-effort
      // only — surface the original error regardless of rollback success.
      if (campaignId != null) {
        try {
          await api.delete<unknown>(`/dashboard/campaigns/${campaignId}`)
        } catch (rollbackErr) {
          // oxlint-disable-next-line no-console -- rollback failures need to surface in dev
          console.error(
            '[campaign-create] rollback delete failed for campaign',
            campaignId,
            rollbackErr
          )
        }
      }

      if (err instanceof ApiError) setError(err.message)
      else if (err instanceof Error) setError(err.message)
      else setError('Unexpected error creating campaign. Check console for details.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = () => setCancelOpen(true)
  const confirmCancel = () => {
    wizard.reset()
    setCancelOpen(false)
    void navigate('/campaigns')
  }

  const hashLists = hashListsQuery.data?.hashLists ?? []
  const hashTypes = hashTypesQuery.data?.hashTypes ?? []
  const wordlists = wordlistsQuery.data?.resources ?? []
  const rulelists = rulelistsQuery.data?.resources ?? []
  const masklists = masklistsQuery.data?.resources ?? []

  const onTemplatePick = async (templateId: number) => {
    try {
      const result = await instantiateTemplate.mutateAsync(templateId)
      const attack = result.attack
      attackForm.setValue('mode', attack.mode)
      attackForm.setValue('wordlistId', attack.wordlistId ?? undefined)
      attackForm.setValue('rulelistId', attack.rulelistId ?? undefined)
      attackForm.setValue('masklistId', attack.masklistId ?? undefined)
      setTemplateError(null)
      setShowTemplatePicker(false)
    } catch (err) {
      if (err instanceof ApiError) setTemplateError(err.message)
      else setTemplateError('Failed to load template')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader>Create Campaign</PageHeader>

      <div className="flex gap-1.5">
        {STEPS.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              if (i < wizard.step) wizard.setStep(i)
            }}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              stepIndicatorStyle(i, wizard.step)
            )}
          >
            {i + 1}. {label}
          </button>
        ))}
      </div>

      {error && <ErrorBanner message={error} />}

      {wizard.step === 0 && (
        <BasicInfoStep
          form={basicInfoForm}
          hashLists={hashLists}
          onSubmit={onBasicInfoSubmit}
          onUploadHashList={() => setUploadModal({ open: true, type: 'hash-lists' })}
          onCancel={handleCancel}
        />
      )}

      {wizard.step === 1 && (
        <div className="space-y-4">
          <div className="flex gap-6">
            <div className="w-2/5 space-y-4">
              <form onSubmit={attackForm.handleSubmit(handleAttackSubmit)} className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Add Attack</h3>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowTemplatePicker(true)}
                  >
                    Start from Template
                  </Button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label htmlFor="mode" className="text-muted-foreground text-xs font-medium">
                      Attack Mode
                    </label>
                    <Select id="mode" className="mt-1.5" {...attackForm.register('mode')}>
                      {ATTACK_MODES.map((mode) => (
                        <option key={mode.value} value={mode.value}>
                          {mode.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label
                      htmlFor="hashTypeId"
                      className="text-muted-foreground text-xs font-medium"
                    >
                      Hash Type
                    </label>
                    <Select
                      id="hashTypeId"
                      className="mt-1.5"
                      {...attackForm.register('hashTypeId')}
                    >
                      <option value="">Auto (from hash list)</option>
                      {hashTypes.map((ht) => (
                        <option key={ht.id} value={ht.id}>
                          {ht.name} (mode {ht.hashcatMode})
                        </option>
                      ))}
                    </Select>
                  </div>
                  {[
                    {
                      id: 'wordlistId' as const,
                      label: 'Wordlist',
                      items: wordlists,
                      modalType: 'wordlists' as UploadModalType,
                    },
                    {
                      id: 'rulelistId' as const,
                      label: 'Rulelist',
                      items: rulelists,
                      modalType: 'rulelists' as UploadModalType,
                    },
                    {
                      id: 'masklistId' as const,
                      label: 'Masklist',
                      items: masklists,
                      modalType: 'masklists' as UploadModalType,
                    },
                  ].map((field) => (
                    <div key={field.id}>
                      <label
                        htmlFor={field.id}
                        className="text-muted-foreground text-xs font-medium"
                      >
                        {field.label}
                      </label>
                      <div className="mt-1.5 flex gap-2">
                        <Select id={field.id} {...attackForm.register(field.id)}>
                          <option value="">None</option>
                          {field.items.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                        </Select>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="shrink-0"
                          onClick={() => setUploadModal({ open: true, type: field.modalType })}
                        >
                          Upload
                        </Button>
                      </div>
                    </div>
                  ))}
                  <div>
                    <label
                      htmlFor="advancedConfiguration"
                      className="text-muted-foreground text-xs font-medium"
                    >
                      Advanced Configuration (JSON, optional)
                    </label>
                    <textarea
                      id="advancedConfiguration"
                      rows={3}
                      placeholder='{"workload-profile": 3}'
                      className="border-surface-0 bg-background text-foreground focus:border-primary focus:ring-primary/40 mt-1.5 w-full rounded border px-3 py-2 font-mono text-xs focus:ring-1"
                      {...attackForm.register('advancedConfiguration')}
                    />
                    {attackForm.formState.errors.advancedConfiguration?.['message'] && (
                      <p className="text-destructive mt-1 text-xs">
                        {String(attackForm.formState.errors.advancedConfiguration['message'])}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" type="submit">
                    {editingIndex != null ? 'Update Attack' : 'Add Attack'}
                  </Button>
                  {editingIndex != null && (
                    <Button variant="secondary" size="sm" type="button" onClick={clearEdit}>
                      Cancel Edit
                    </Button>
                  )}
                </div>
              </form>

              <AttackList
                attacks={wizard.attacks}
                editingIndex={editingIndex}
                onEdit={seedFormFromAttack}
                onRemove={handleRemoveAttack}
              />
            </div>

            <AttackDagEditor
              attacks={wizard.attacks}
              nodes={nodes}
              edges={edges}
              cycle={dagValidation.cycle}
              isValid={dagValidation.valid}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={handleConnect}
              onEdgesDelete={handleEdgeDelete}
              onNodeClick={handleNodeClick}
              onNodeContextMenu={handleNodeContextMenu}
            />
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => wizard.setStep(0)}>
              Back
            </Button>
            <Button
              onClick={() => wizard.setStep(2)}
              disabled={wizard.attacks.length === 0 || !dagValidation.valid}
            >
              Next: Review
            </Button>
            <Button variant="secondary" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {wizard.step === 2 && (
        <div className="space-y-4">
          <div className="border-surface-0 bg-surface-0/40 rounded-md border p-4">
            <h3 className="text-muted-foreground mb-3 text-xs font-medium tracking-wider uppercase">
              Campaign Summary
            </h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-medium">{wizard.name}</dd>
              </div>
              {wizard.description && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Description</dt>
                  <dd className="max-w-xs truncate">{wizard.description}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Priority</dt>
                <dd className="font-mono">{wizard.priority}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Hash List</dt>
                <dd className="font-mono">#{wizard.hashListId}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Attacks</dt>
                <dd>
                  <StatusBadge status={`${wizard.attacks.length} configured`} />
                </dd>
              </div>
            </dl>
          </div>

          {wizard.attacks.length > 0 && (
            <div className="border-surface-0 bg-surface-0/40 rounded-md border p-4">
              <h3 className="text-muted-foreground mb-3 text-xs font-medium tracking-wider uppercase">
                DAG Preview
              </h3>
              <div className="bg-crust h-[300px] rounded">
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
            <Button variant="secondary" onClick={() => wizard.setStep(1)}>
              Back
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Creating...' : 'Create Campaign'}
            </Button>
            <Button variant="secondary" onClick={handleCancel} disabled={submitting}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {showTemplatePicker && (
        <TemplatePickerOverlay
          templates={templatesData?.templates ?? []}
          isPending={instantiateTemplate.isPending}
          error={templateError}
          onPick={onTemplatePick}
          onClose={() => setShowTemplatePicker(false)}
        />
      )}

      <ConfirmDialog
        open={cancelOpen}
        title="Discard campaign?"
        message="The wizard will close and your in-progress configuration will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        destructive
        busy={submitting}
        onConfirm={confirmCancel}
        onCancel={() => setCancelOpen(false)}
      />

      <ResourceUploadModal
        type={uploadModal.type}
        open={uploadModal.open}
        onClose={() => setUploadModal((prev) => ({ ...prev, open: false }))}
        onSuccess={(resourceId) => {
          if (uploadModal.type === 'hash-lists') {
            basicInfoForm.setValue('hashListId', resourceId)
          } else if (uploadModal.type === 'wordlists') {
            attackForm.setValue('wordlistId', resourceId)
          } else if (uploadModal.type === 'rulelists') {
            attackForm.setValue('rulelistId', resourceId)
          } else if (uploadModal.type === 'masklists') {
            attackForm.setValue('masklistId', resourceId)
          }
        }}
      />
    </div>
  )
}
