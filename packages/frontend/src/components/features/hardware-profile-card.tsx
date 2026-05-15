import { EmptyState } from '../ui/empty-state';

interface HardwareProfileCardProps {
  profile: Record<string, unknown> | null | undefined;
}

interface OsInfo {
  name?: string;
  version?: string;
  platform?: string;
}

interface CpuInfo {
  model?: string;
  cores?: number;
}

interface RamInfo {
  totalMb?: number;
  availableMb?: number;
  total?: number;
  available?: number;
}

interface GpuInfo {
  model?: string;
  driver?: string;
  driverVersion?: string;
  memoryMb?: number;
  memory?: number;
}

// Labeled-cast helper: agent-reported jsonb has no enforced schema, so we
// accept only the plain-object shape we know how to render. Arrays, Dates,
// Maps, Sets, and other non-plain objects are rejected so a firmware drift
// surfaces as a visible warning rather than silently rendering "—" rows.
function pick<T>(value: unknown, label: string): T | undefined {
  if (value === undefined) return undefined;
  const isPlainObject =
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
  if (!isPlainObject) {
    // biome-ignore lint/suspicious/noConsole: client-side observability has no structured logger
    console.warn(`[HardwareProfileCard] ${label} has unexpected shape`, value);
    return undefined;
  }
  return value as T;
}

function formatBytes(mb: number | undefined): string {
  if (typeof mb !== 'number' || !Number.isFinite(mb)) {
    return '—';
  }
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

function Row({ label, value }: { label: string; value: string | number | undefined }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono text-xs">
        {value === undefined || value === null || value === '' ? '—' : value}
      </dd>
    </div>
  );
}

function isKnownShape(profile: Record<string, unknown>): boolean {
  return ['os', 'cpu', 'ram', 'gpus', 'hashcatVersion'].some((key) => key in profile);
}

export function HardwareProfileCard({ profile }: HardwareProfileCardProps) {
  if (!profile) {
    return (
      <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Hardware
        </h3>
        <EmptyState message="No hardware profile reported yet." />
      </div>
    );
  }

  const known = isKnownShape(profile);
  if (!known) {
    return (
      <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Hardware
        </h3>
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Raw profile (unknown shape)
          </summary>
          <pre className="mt-2 overflow-auto font-mono text-xs leading-relaxed text-muted-foreground">
            {JSON.stringify(profile, null, 2)}
          </pre>
        </details>
      </div>
    );
  }

  const os = pick<OsInfo>(profile['os'], 'os');
  const cpu = pick<CpuInfo>(profile['cpu'], 'cpu');
  const ram = pick<RamInfo>(profile['ram'], 'ram');
  const gpusRaw = profile['gpus'];
  const gpus: GpuInfo[] = Array.isArray(gpusRaw) ? (gpusRaw as GpuInfo[]) : [];
  const hashcatVersion =
    typeof profile['hashcatVersion'] === 'string' ? (profile['hashcatVersion'] as string) : '';

  const ramTotal = ram?.totalMb ?? ram?.total;
  const ramAvailable = ram?.availableMb ?? ram?.available;

  return (
    <div className="space-y-4 rounded-md border border-surface-0 bg-surface-0/40 p-4">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Hardware
      </h3>

      {os && (
        <section>
          <h4 className="mb-1.5 text-xs font-medium text-foreground">OS</h4>
          <dl className="space-y-1 text-sm">
            <Row label="Name" value={os.name} />
            <Row label="Version" value={os.version} />
            <Row label="Platform" value={os.platform} />
          </dl>
        </section>
      )}

      {cpu && (
        <section>
          <h4 className="mb-1.5 text-xs font-medium text-foreground">CPU</h4>
          <dl className="space-y-1 text-sm">
            <Row label="Model" value={cpu.model} />
            <Row label="Cores" value={cpu.cores} />
          </dl>
        </section>
      )}

      {ram && (
        <section>
          <h4 className="mb-1.5 text-xs font-medium text-foreground">RAM</h4>
          <dl className="space-y-1 text-sm">
            <Row label="Total" value={formatBytes(ramTotal)} />
            <Row label="Available" value={formatBytes(ramAvailable)} />
          </dl>
        </section>
      )}

      <section>
        <h4 className="mb-1.5 text-xs font-medium text-foreground">GPUs ({gpus.length})</h4>
        {gpus.length === 0 ? (
          <p className="text-xs text-muted-foreground">No GPUs reported.</p>
        ) : (
          <ul className="space-y-2">
            {gpus.map((gpu, idx) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: agent-reported GPU profile has no stable id; model+idx is the strongest available key
                key={`gpu-${idx}-${gpu.model ?? 'unknown'}`}
                className="rounded border border-surface-0 bg-surface-1/30 p-2 text-sm"
              >
                <dl className="space-y-1">
                  <Row label="Model" value={gpu.model} />
                  <Row label="Memory" value={formatBytes(gpu.memoryMb ?? gpu.memory)} />
                  <Row label="Driver" value={gpu.driver ?? gpu.driverVersion} />
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      {hashcatVersion && (
        <section>
          <dl className="space-y-1 text-sm">
            <Row label="Hashcat version" value={hashcatVersion} />
          </dl>
        </section>
      )}
    </div>
  );
}
