# ADR-0005: Version the public API after 1.0

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r), AI pair (Claude Code)

## Context

[ADR-0004](0004-agent-api-revisable-until-1.0.md) keeps the agent API
revisable in place until 1.0 and deferred the post-1.0 stability policy to a
follow-up. This is that policy. The public surfaces already carry an
`/api/v1/` path prefix, but it is not yet meaningful — there is one version
and it changes in place. After 1.0 there are independently-deployed consumers
(released agents on air-gapped LANs, CLI/control tooling, CI) that cannot be
upgraded in lockstep with the server, so the contract needs a way to evolve
without breaking them.

## Decision

After 1.0, a breaking change to a public API surface is delivered as a new
major version under a distinct path prefix (`/api/v2/...`), with the previous
major version kept operational through a defined deprecation window. Within a
major version, only backward-compatible (additive) changes are allowed.
Pre-1.0 behavior is unchanged (ADR-0004: revise in place).

## Alternatives Considered

### Alternative 1: Header / media-type versioning (`Accept: application/vnd.hashhive.v2+json`)

- **Pros**: clean URLs; content negotiation.
- **Cons**: harder to curl, test, and debug; worse ergonomics for agent and
  CLI tooling.
- **Why not**: path versioning matches the existing `/v1/` convention and the
  operator/agent tooling story.

### Alternative 2: No versioning; coordinated rolling upgrades forever

- **Pros**: no dual-version maintenance.
- **Why not**: acceptable pre-1.0 (ADR-0004) but post-1.0 the air-gapped
  agents and CI/CLI consumers can't be upgraded in lockstep.

### Alternative 3: Per-endpoint versioning

- **Why not**: fragments the contract; a surface-wide major version is
  simpler to document and reason about.

## Consequences

### Positive

- Shipped agents and tooling keep working across a server upgrade.
- The existing `/v1/` prefix becomes meaningful; breaking changes have a clear
  home.

### Negative

- Maintaining two major versions during the window doubles surface area and
  test cost.
- Requires a deprecation policy and a way to know when the old version is safe
  to retire.

### Risks

- Open specifics to settle before the first post-1.0 break: deprecation-window
  length, sunset signaling (`Deprecation`/`Sunset` headers), and whether the
  three surfaces version in lockstep or independently.
- Air-gapped deployments make old-version usage telemetry impractical;
  operators likely need an explicit upgrade runbook instead.
