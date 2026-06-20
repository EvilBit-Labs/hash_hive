# ADR-0003: Bind enrolled agents to their enrollment token

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r), AI pair (Claude Code)

## Context

The agent `/enroll` path is idempotent on a stable `clientId` so a dropped
`201` can be retried without minting a duplicate agent (see
[ADR-0001](0001-agent-enrollment-two-token-exchange.md)). A PR #245 review
found that the idempotent re-issue path re-issued a bearer for any
`(project, clientId)` without checking the token's state or identity. Two
flaws followed: a **revoked/expired token could still re-issue** a bearer
(revocation, the documented remediation for a leak, was bypassed), and
**any** holder of *any* valid project enrollment token could re-credential —
and thereby rotate/DoS — *any* agent in that project by replaying its
`clientId`. Since `issueAgentBearer` rotates the agent's live credential,
this is both credential theft and a denial of service against the displaced
agent.

## Decision

We bind each enrolled agent to the token that enrolled it via
`agents.enrolled_by_token_id` (migration 0021). On the idempotent re-issue
path, only the *same* token may re-issue an agent's bearer, and only after a
guarded touch (`WHERE not-revoked AND not-expired`) confirms the token is
still active. A foreign or legacy (NULL-binding) token presenting a known
`clientId` is rejected as opaque `invalid`.

## Alternatives Considered

### Alternative 1: Guard the re-issue path only, document the residual

- **Pros**: fixes the critical revocation bypass with a ~3-line guard; no
  schema change; keeps re-keying a rig with a replacement token frictionless.
- **Cons**: leaves clientId-squatting open — any valid project token can
  still re-credential any agent in the project.
- **Why not**: under the project's "fix all findings, no deferrals" policy
  the owner chose to close the squatting vector fully, accepting the
  workflow cost.

### Alternative 2: Refuse re-issue entirely (drop idempotency)

- **Pros**: no token can ever re-credential an existing agent; simplest
  authz story.
- **Why not**: idempotency exists specifically to recover a dropped
  enrollment response; removing it reintroduces duplicate-agent minting on
  retry.

### Alternative 3: Raise the bar without binding (clientId entropy floor, per-token rate limits)

- **Pros**: makes guessing an enrolled `clientId` harder.
- **Why not**: mitigations, not a fix — a token that legitimately knows a
  `clientId` could still re-credential a foreign agent. Binding removes the
  capability rather than throttling it.

## Consequences

### Positive

- Revocation is fully effective: a revoked token cannot re-issue on any path.
- Cross-agent re-credentialing is impossible — a token can only ever re-issue
  agents it originally enrolled.
- The guarded touch makes the check atomic and robust to a concurrent revoke.

### Negative

- Re-keying an existing rig with a *replacement* token now requires deleting
  and re-enrolling that agent; a revoked token's agents cannot be
  re-credentialed with a new token in place.
- A second nullable FK on the hot `agents` table.

### Risks

- Concurrency correctness (guarded touch + binding under a same-`clientId`
  race) is proven by reasoning and unit tests, not a real-DB concurrency
  test — the same caveat ADR-0001 carries, to be closed by the planned
  testcontainers work.
- Legacy/migrated agents carry a NULL binding and are intentionally
  unreachable via `/enroll` (they have a NULL `clientId`); any future
  backfill that assigns them a `clientId` must also set a binding or they
  become permanently non-re-issuable.
