/**
 * Agent capability helpers.
 *
 * Agents advertise the cracker engines they run via
 * `capabilities.engines: Array<{ name, version }>`. Older agents that
 * have not adopted the new field still send the legacy
 * `capabilities.hashcatVersion` string. `getPrimaryEngine` collapses
 * both into a uniform `{ name, version }` shape so consumers can render
 * a single "Engine / Version" cell without inline branching.
 */
import type { EngineDescriptor } from '@hashhive/shared';

/**
 * Result of `getPrimaryEngine`. Reuses the shared `EngineDescriptor`
 * shape so backend and frontend agree on field names and the legacy
 * `hashcatVersion` fallback synthesizes the same record an agent emits
 * via `capabilities.engines[0]`.
 */
export type PrimaryEngine = EngineDescriptor;

interface CapabilitiesShape {
  engines?: Array<{ name?: unknown; version?: unknown }>;
  hashcatVersion?: unknown;
}

export function getPrimaryEngine(
  capabilities: Record<string, unknown> | null | undefined
): PrimaryEngine | null {
  if (!capabilities) return null;
  const caps = capabilities as CapabilitiesShape;

  const first = caps.engines?.[0];
  if (first && typeof first.name === 'string' && typeof first.version === 'string') {
    return { name: first.name, version: first.version };
  }

  if (typeof caps.hashcatVersion === 'string' && caps.hashcatVersion.length > 0) {
    return { name: 'hashcat', version: caps.hashcatVersion };
  }

  return null;
}

export function formatPrimaryEngine(engine: PrimaryEngine | null): string {
  if (!engine) return '—';
  // Trim defends against an agent emitting `{ version: '' }` or whitespace.
  const version = engine.version.trim();
  return version ? `${engine.name} ${version}` : engine.name;
}
