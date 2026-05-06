import { useState } from 'react';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { ErrorBanner } from '../components/ui/error-banner';
import { PageHeader } from '../components/ui/page-header';
import { useApiKeyMetadata, useIssueApiKey, useRevokeApiKey } from '../hooks/use-api-key';

const ROTATE_WARNING =
  'Rotating issues a new API key. Any tooling using the previous key will stop working until you update it.';

const REVOKE_WARNING =
  'Revoking deletes the current API key. Any tooling using it will immediately stop working until a new key is issued.';

export function AccountPage() {
  return (
    <div className="space-y-6">
      <PageHeader>Account</PageHeader>
      <ApiKeySection />
    </div>
  );
}

function ApiKeySection() {
  const { data: metadata, isLoading } = useApiKeyMetadata();
  const [actionError, setActionError] = useState<string | null>(null);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'rotate' | 'revoke' | null>(null);

  const issueMutation = useIssueApiKey({ onError: setActionError });
  const revokeMutation = useRevokeApiKey({ onError: setActionError });

  const handleIssue = () => {
    setActionError(null);
    issueMutation.mutate(undefined, {
      onSuccess: (data) => {
        setRawToken(data.token);
        setConfirm(null);
      },
    });
  };

  const handleRevoke = () => {
    setActionError(null);
    revokeMutation.mutate(undefined, {
      onSettled: () => {
        setRawToken(null);
        setConfirm(null);
      },
    });
  };

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Control API Key</h2>
        <span className="text-xs text-muted-foreground">For automation, CI, and CLI tools</span>
      </header>

      {actionError && <ErrorBanner message={actionError} />}

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : rawToken ? (
        <RawTokenReveal token={rawToken} onDismiss={() => setRawToken(null)} />
      ) : metadata?.hasKey ? (
        <ExistingKeyView
          prefix={metadata.prefix ?? '-'}
          lastUsedAt={metadata.lastUsedAt}
          rotateBusy={issueMutation.isPending}
          revokeBusy={revokeMutation.isPending}
          onRotate={() => setConfirm('rotate')}
          onRevoke={() => setConfirm('revoke')}
        />
      ) : (
        <NoKeyView busy={issueMutation.isPending} onIssue={handleIssue} />
      )}

      <ConfirmDialog
        open={confirm === 'rotate'}
        title="Rotate API key?"
        message={ROTATE_WARNING}
        confirmLabel="Rotate"
        destructive
        busy={issueMutation.isPending}
        onConfirm={handleIssue}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={confirm === 'revoke'}
        title="Revoke API key?"
        message={REVOKE_WARNING}
        confirmLabel="Revoke"
        destructive
        busy={revokeMutation.isPending}
        onConfirm={handleRevoke}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}

function NoKeyView({ busy, onIssue }: { busy: boolean; onIssue: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        You do not have an active API key. Generate one to authenticate against
        <code className="mx-1 rounded bg-muted px-1">/api/v1/control/*</code> for scripted access.
      </p>
      <Button onClick={onIssue} disabled={busy}>
        {busy ? 'Generating...' : 'Generate API Key'}
      </Button>
    </div>
  );
}

function ExistingKeyView({
  prefix,
  lastUsedAt,
  rotateBusy,
  revokeBusy,
  onRotate,
  onRevoke,
}: {
  prefix: string;
  lastUsedAt: string | null;
  rotateBusy: boolean;
  revokeBusy: boolean;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Key</dt>
        <dd className="font-mono">{prefix}</dd>
        <dt className="text-muted-foreground">Last used</dt>
        <dd>{formatLastUsed(lastUsedAt)}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        The raw token is only shown once at issue time. If you've lost it, rotate to generate a new
        one.
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onRotate} disabled={rotateBusy}>
          {rotateBusy ? 'Rotating...' : 'Rotate'}
        </Button>
        <Button variant="destructive" onClick={onRevoke} disabled={revokeBusy}>
          {revokeBusy ? 'Revoking...' : 'Revoke'}
        </Button>
      </div>
    </div>
  );
}

function RawTokenReveal({ token, onDismiss }: { token: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
        Save this token now. It will not be shown again.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
          {token}
        </code>
        <Button onClick={handleCopy} variant="secondary" className="text-xs">
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Store it in a password manager or your tool's secret store. Treat it like a password; anyone
        with this token can act as you against the Control API.
      </p>
      <Button onClick={onDismiss} variant="secondary" className="text-xs">
        I've saved it
      </Button>
    </div>
  );
}

function formatLastUsed(value: string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
