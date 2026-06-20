import type { CreateEnrollmentTokenRequest, EnrollmentTokenMetadata } from '@hashhive/shared'

import { KeyRound } from 'lucide-react'
import { useState } from 'react'

import {
  useCreateEnrollmentToken,
  useEnrollmentTokens,
  useRevokeEnrollmentToken,
} from '../../hooks/use-enrollment-tokens'
import { buildAgentEnrollCommand } from '../../lib/agent-enroll-command'
import { Button } from '../ui/button'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { CopyableBlock } from '../ui/copyable-block'
import { ErrorBanner } from '../ui/error-banner'
import { Input } from '../ui/input'
import { SegmentedControl } from '../ui/segmented-control'
import { Table, TableBody, TableHead, Td, Th } from '../ui/table'

interface EnrollmentTokenManagerProps {
  /** Dashboard origin used in the agent command (pass window.location.origin). */
  readonly serverOrigin: string
}

/**
 * Admin surface for minting and managing agent enrollment tokens. The
 * raw token is shown exactly once after minting, alongside the command
 * the operator runs on a new rig. Mirrors the Account page's Control API
 * Key card (display-once reveal) but manages a list of project-scoped
 * tokens. Gate this behind an admin PermissionGuard at the call site.
 */
export function EnrollmentTokenManager({ serverOrigin }: EnrollmentTokenManagerProps) {
  const { data: tokens, isLoading, error: queryError } = useEnrollmentTokens()
  const [actionError, setActionError] = useState<string | null>(null)
  const [rawToken, setRawToken] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState<EnrollmentTokenMetadata | null>(null)

  const createMutation = useCreateEnrollmentToken({ onError: setActionError })
  const revokeMutation = useRevokeEnrollmentToken({ onError: setActionError })

  const handleMinted = (token: string) => {
    setRawToken(token)
    setShowForm(false)
  }

  return (
    <section
      className="space-y-4"
      data-testid="enrollment-token-manager"
      aria-label="Enrollment tokens"
    >
      {actionError && <ErrorBanner message={actionError} />}
      {queryError && <ErrorBanner message="Couldn't load enrollment tokens. Reload to retry." />}

      {rawToken ? (
        <RawEnrollmentTokenReveal
          token={rawToken}
          serverOrigin={serverOrigin}
          onDismiss={() => setRawToken(null)}
        />
      ) : showForm ? (
        <MintForm
          busy={createMutation.isPending}
          onCancel={() => setShowForm(false)}
          onSubmit={(req) => {
            setActionError(null)
            createMutation.mutate(req, { onSuccess: (data) => handleMinted(data.token) })
          }}
        />
      ) : (
        <Button onClick={() => setShowForm(true)} className="gap-2">
          <KeyRound className="h-4 w-4" aria-hidden="true" />
          Generate enrollment token
        </Button>
      )}

      <TokenList
        tokens={tokens ?? []}
        isLoading={isLoading}
        revokeBusyId={revokeMutation.isPending ? confirmRevoke?.id : undefined}
        onRevoke={setConfirmRevoke}
      />

      <ConfirmDialog
        open={confirmRevoke !== null}
        title="Revoke enrollment token?"
        message="Agents that haven't enrolled yet won't be able to use it. Already-enrolled agents keep working — they have their own tokens."
        confirmLabel="Revoke"
        destructive
        busy={revokeMutation.isPending}
        onConfirm={() => {
          if (!confirmRevoke) return
          setActionError(null)
          revokeMutation.mutate(confirmRevoke.id, { onSettled: () => setConfirmRevoke(null) })
        }}
        onCancel={() => setConfirmRevoke(null)}
      />
    </section>
  )
}

function MintForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean
  onSubmit: (req: CreateEnrollmentTokenRequest) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<'one-time' | 'reusable'>('one-time')
  const [maxUses, setMaxUses] = useState('')
  const [expiresInDays, setExpiresInDays] = useState('')

  const submit = () => {
    const isReusable = kind === 'reusable'
    const maxUsesNum = Number(maxUses)
    const daysNum = Number(expiresInDays)
    // Positive integers only; empty / non-positive values are simply
    // omitted (their absence is meaningful: unlimited uses / no expiry).
    const req: CreateEnrollmentTokenRequest = {
      isReusable,
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(isReusable && Number.isInteger(maxUsesNum) && maxUsesNum > 0
        ? { maxUses: maxUsesNum }
        : {}),
      ...(Number.isInteger(daysNum) && daysNum > 0
        ? { expiresAt: new Date(Date.now() + daysNum * 86_400_000).toISOString() }
        : {}),
    }
    onSubmit(req)
  }

  return (
    <div className="space-y-4 rounded-md border border-surface-1 bg-surface-0/40 p-4">
      <div className="space-y-1.5">
        <label htmlFor="etk-label" className="text-xs font-medium text-foreground/80">
          Label <span className="text-muted-foreground">(optional)</span>
        </label>
        <Input
          id="etk-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. rack-3 rigs"
          maxLength={255}
        />
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-medium text-foreground/80">Type</span>
        <SegmentedControl
          aria-label="Token type"
          value={kind}
          onChange={(v) => setKind(v as 'one-time' | 'reusable')}
          options={[
            { value: 'one-time', label: 'One-time' },
            { value: 'reusable', label: 'Reusable' },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          {kind === 'one-time'
            ? 'Registers a single agent, then stops working.'
            : 'Registers many agents — good for bringing up a rack at once.'}
        </p>
      </div>

      {kind === 'reusable' && (
        <div className="space-y-1.5">
          <label htmlFor="etk-max-uses" className="text-xs font-medium text-foreground/80">
            Max uses <span className="text-muted-foreground">(optional — blank = unlimited)</span>
          </label>
          <Input
            id="etk-max-uses"
            type="number"
            min={1}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            placeholder="unlimited"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="etk-expiry" className="text-xs font-medium text-foreground/80">
          Expires in days <span className="text-muted-foreground">(optional — blank = never)</span>
        </label>
        <Input
          id="etk-expiry"
          type="number"
          min={1}
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(e.target.value)}
          placeholder="never"
        />
      </div>

      <div className="flex gap-2">
        <Button onClick={submit} disabled={busy}>
          {busy ? 'Generating...' : 'Generate token'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function TokenList({
  tokens,
  isLoading,
  revokeBusyId,
  onRevoke,
}: {
  tokens: readonly EnrollmentTokenMetadata[]
  isLoading: boolean
  revokeBusyId: number | undefined
  onRevoke: (token: EnrollmentTokenMetadata) => void
}) {
  if (isLoading) return <p className="text-xs text-muted-foreground">Loading tokens...</p>
  if (tokens.length === 0) {
    return <p className="text-xs text-muted-foreground">No enrollment tokens yet.</p>
  }

  return (
    <Table>
      <TableHead>
        <tr>
          <Th>Label</Th>
          <Th>Type</Th>
          <Th>Uses</Th>
          <Th>Status</Th>
          <Th>
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </TableHead>
      <TableBody>
        {tokens.map((token) => {
          const status = tokenStatus(token)
          return (
            <tr key={token.id} className="border-t border-surface-1">
              <Td className="text-sm">
                {token.label ?? <span className="text-muted-foreground">—</span>}
              </Td>
              <Td className="text-xs text-muted-foreground">
                {token.isReusable ? 'Reusable' : 'One-time'}
              </Td>
              <Td className="text-xs text-muted-foreground">
                {token.useCount}
                {token.maxUses ? ` / ${token.maxUses}` : token.isReusable ? ' / ∞' : ''}
              </Td>
              <Td className="text-xs">{status.label}</Td>
              <Td className="text-right">
                {status.active && (
                  <Button
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={revokeBusyId === token.id}
                    onClick={() => onRevoke(token)}
                  >
                    {revokeBusyId === token.id ? 'Revoking...' : 'Revoke'}
                  </Button>
                )}
              </Td>
            </tr>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** Derive a labelled status (color is never the only signal — principle 3). */
function tokenStatus(token: EnrollmentTokenMetadata): { label: string; active: boolean } {
  if (token.revokedAt) return { label: 'Revoked', active: false }
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
    return { label: 'Expired', active: false }
  }
  if (!token.isReusable && token.useCount > 0) return { label: 'Used', active: false }
  return { label: 'Active', active: true }
}

function RawEnrollmentTokenReveal({
  token,
  serverOrigin,
  onDismiss,
}: {
  token: string
  serverOrigin: string
  onDismiss: () => void
}) {
  const command = buildAgentEnrollCommand(serverOrigin, token)
  return (
    <div className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-3">
      <p className="text-xs font-semibold text-warning">
        Here's your enrollment token — copy it now, it won't be shown again.
      </p>
      <CopyableBlock value={token} ariaLabel="Copy enrollment token" oneLine />
      <p className="text-xs text-muted-foreground">
        Run this on the worker machine you want to register. It'll show up here within a few
        seconds.
      </p>
      <CopyableBlock value={command} ariaLabel="Copy agent command" />
      <Button onClick={onDismiss} variant="secondary" className="text-xs">
        Done
      </Button>
    </div>
  )
}
