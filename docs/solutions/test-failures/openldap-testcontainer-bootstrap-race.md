---
title: "OpenLDAP testcontainer: seeding races the entrypoint's bootstrap slapd, so the memberof overlay never backpatches"
date: 2026-07-12
category: docs/solutions/test-failures
module: packages/backend
problem_type: test_failure
component: testing_framework
symptoms:
  - "LDAP container test lane fails deterministically in CI: 'ldap-container: memberOf on uid=admin-user,... never settled to include cn=hh-admins-memberof,... after 15 attempts', then 'failed to boot and seed a working directory after 6 attempts'"
  - "Passes intermittently locally and in isolation, so it reads like flaky Docker contention rather than a real bug"
  - "The memberof overlay config is correct, and a manual ldapadd against a fully-booted container backpatches memberOf synchronously every time"
root_cause: race_condition
resolution_type: code_fix
severity: high
tags: [testcontainers, openldap, osixia, memberof, ldap, wait-strategy, ci, real-db-lane]
---

# OpenLDAP testcontainer: seeding races the entrypoint's bootstrap slapd

## Problem

An `osixia/openldap` container booted via testcontainers with `Wait.forListeningPorts()` reports "ready" while the image is still bootstrapping, so seeding fixtures over LDAP races the entrypoint's own config load. The `memberof` overlay never backpatches `memberOf` onto the seeded users, and the readiness poll times out — deterministically on CI, intermittently locally.

## Symptoms

- `ldap-container: memberOf on uid=admin-user,... never settled ... after 15 attempts` → `failed to boot and seed a working directory after 6 attempts`.
- Two container-backed LDAP tests fail together; both pass when run in isolation or on a re-run.
- Reads like host Docker contention (and it can be masked by it), so the first instinct — bump timeouts / add boot retries — is wrong.

## What Didn't Work

- **Increasing the memberof settle-poll count and the whole-container boot-retry budget** (6 boots × 15 settle polls). The overlay never fires within the race window, so more retries just fail slower.
- **Blaming the overlay config.** Inspecting `cn=config` (`olcMemberOfGroupOC` / `olcMemberOfMemberAD`) showed it already matched what the helper seeds (`groupOfUniqueNames` / `uniqueMember`); a manual `ldapadd` against a fully-booted container backpatched `memberOf` on the first try.
- **Attributing it to local Docker contention.** The failure is deterministic on a clean CI runner, so contention was a red herring that delayed finding the real race.

## Solution

The root cause: `osixia/openldap`'s entrypoint runs a **transient bootstrap `slapd`** on port 389 while it loads schemas and default LDIF into `cn=config`, then stops it and hands off to the real, long-running foreground `slapd`. `Wait.forListeningPorts()` can report the container ready **during that bootstrap window**, so `seedFixtures` writes into a database the entrypoint is concurrently loading (single-writer mdb), and the group's `uniqueMember` add lands in a state the overlay never backpatches.

Wait for the foreground `slapd`'s startup log line in addition to the port. The `slapd starting` line is emitted **once**, only after the bootstrap sequence has fully completed:

```typescript
// Before — reports ready mid-bootstrap:
.withWaitStrategy(Wait.forListeningPorts())

// After — waits for the real foreground slapd:
.withWaitStrategy(
  Wait.forAll([
    Wait.forListeningPorts(),
    Wait.forLogMessage(/slapd starting/),
  ]).withStartupTimeout(120_000),
)
```

Result: `memberOf` settles on the **first** boot attempt, and the two container-backed tests drop from ~19–53s (retry/poll-heavy) to ~2–4s combined.

## Why This Works

The bug is a readiness lie, not an overlay failure. Port-listening is necessary but not sufficient for an image whose entrypoint listens on that same port during a preparatory phase. Gating on a log line the image emits only at final hand-off removes the race at its source, so no seed operation can run against the half-initialized `cn=config`. The pre-existing boot-retries and settle-poll remain as cheap defense-in-depth against ordinary host contention, but they are no longer load-bearing.

## Prevention

- **For any container whose image does multi-phase startup (a bootstrap DB load, an init sidecar, schema seeding), never rely on `Wait.forListeningPorts()` alone.** Combine it with `Wait.forLogMessage(<final-ready line>)` via `Wait.forAll([...])`. Port-open is a floor, not a ready signal.
- **When a container test is "flaky" but the service config checks out, suspect a readiness race before contention.** Determinism on CI (vs. intermittency locally) is the tell: a clean runner exposes the race that a busy local host sometimes hides.
- **Prefer a deterministic readiness gate over retry budgets.** Retries that "converge" are masking a race; the fix belongs at the wait strategy, and success should be observable as "settles on boot attempt 1", not "passes after N retries".

See the shared helper `packages/backend/tests/db/support/ldap-container.ts` for the applied fix.
