/**
 * System health card (issue #109).
 *
 * Renders the four-component health snapshot (database, redis, minio,
 * queues) with status dots and per-component messages on degraded /
 * unhealthy. Click a row to expand its raw `detail` payload.
 *
 * Aria: aggregate status uses role="status" + aria-live="polite" so
 * screen readers announce changes. Status dots respect
 * prefers-reduced-motion (no pulse on unhealthy).
 */
import { useState } from 'react';
import {
  type ComponentHealth,
  type ComponentName,
  type ComponentStatus,
  useSystemHealth,
} from '../../hooks/use-system-health';
import { cn } from '../../lib/utils';

const COMPONENT_LABELS: Record<ComponentName, string> = {
  database: 'Database',
  redis: 'Redis',
  minio: 'Object Storage',
  queues: 'Job Queues',
};

const COMPONENT_ORDER: ComponentName[] = ['database', 'redis', 'minio', 'queues'];

const STATUS_DOT: Record<ComponentStatus, string> = {
  healthy: 'bg-success',
  degraded: 'bg-warning',
  unhealthy: 'bg-destructive',
};

const AGGREGATE_LABEL: Record<ComponentStatus, string> = {
  healthy: 'All systems healthy',
  degraded: 'Degraded',
  unhealthy: 'Unhealthy',
};

/**
 * Renders an error from an unknown reject value. Plain-string and
 * plain-object rejections (from custom fetch wrappers) need a fallback
 * description so the user sees something more actionable than a bare
 * "Failed to load system health".
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return 'unknown error';
}

interface StatusDotProps {
  status: ComponentStatus;
  pulse?: boolean;
}

function StatusDot({ status, pulse = false }: StatusDotProps) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
      {pulse && status !== 'healthy' && (
        // motion-reduce:hidden honors prefers-reduced-motion via Tailwind.
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:hidden',
            STATUS_DOT[status]
          )}
        />
      )}
      <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', STATUS_DOT[status])} />
    </span>
  );
}

interface ComponentRowProps {
  name: ComponentName;
  health: ComponentHealth;
}

function ComponentRow({ name, health }: ComponentRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = !!health.detail && Object.keys(health.detail).length > 0;
  const showMessage = health.status !== 'healthy' && !!health.message;

  const rowContent = (
    <div className="flex items-center gap-3">
      <StatusDot status={health.status} />
      <span className="text-sm font-medium text-foreground">{COMPONENT_LABELS[name]}</span>
      <span className="ml-auto font-mono text-xs uppercase tracking-wider text-muted-foreground">
        {health.status}
      </span>
    </div>
  );

  return (
    <div className="border-b border-surface-0 last:border-b-0">
      {hasDetail ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={`${COMPONENT_LABELS[name]} status: ${health.status}. Click to ${expanded ? 'hide' : 'show'} details.`}
          className="block w-full px-3 py-2 text-left transition-colors hover:bg-surface-0/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {rowContent}
        </button>
      ) : (
        // No detail to expand → static row. The visible label + status
        // text inside `rowContent` is sufficient for screen readers; an
        // additional aria-label on a div is rejected by lint anyway.
        <div className="block w-full px-3 py-2">{rowContent}</div>
      )}
      {showMessage && <p className="px-3 pb-2 text-xs text-muted-foreground">{health.message}</p>}
      {expanded && hasDetail && (
        <pre className="overflow-x-auto border-t border-surface-0 bg-surface-0/30 px-3 py-2 font-mono text-xs text-muted-foreground">
          {JSON.stringify(health.detail, null, 2)}
        </pre>
      )}
    </div>
  );
}

interface SkeletonRowProps {
  label: string;
}

function SkeletonRow({ label }: SkeletonRowProps) {
  return (
    <div className="flex items-center gap-3 border-b border-surface-0 px-3 py-2 last:border-b-0">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-surface-0" aria-hidden="true" />
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <span className="ml-auto font-mono text-xs uppercase tracking-wider text-muted-foreground">
        --
      </span>
    </div>
  );
}

export function SystemHealthCard() {
  const { data, isLoading, isError, error } = useSystemHealth();

  return (
    <section
      className="rounded-md border border-surface-0 bg-surface-0/40"
      aria-labelledby="system-health-title"
    >
      <header className="flex items-center justify-between border-b border-surface-0 px-3 py-2">
        <h2
          id="system-health-title"
          className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
        >
          System Health
        </h2>
        {data ? (
          <div
            className="flex items-center gap-2"
            role="status"
            aria-live="polite"
            aria-label={`System status: ${AGGREGATE_LABEL[data.status]}`}
          >
            <StatusDot status={data.status} pulse />
            <span className="text-xs font-medium text-foreground">
              {AGGREGATE_LABEL[data.status]}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">--</span>
        )}
      </header>

      {isError && (
        <div
          role="alert"
          className="border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          Failed to load system health: {describeError(error)}
        </div>
      )}

      <div>
        {isLoading || !data
          ? COMPONENT_ORDER.map((name) => <SkeletonRow key={name} label={COMPONENT_LABELS[name]} />)
          : COMPONENT_ORDER.map((name) => (
              <ComponentRow key={name} name={name} health={data.components[name]} />
            ))}
      </div>
    </section>
  );
}
