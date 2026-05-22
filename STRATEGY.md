---
name: HashHive
last_updated: 2026-05-22
---

# HashHive Strategy

## Target problem

Red team operators running multiple large, multi-stage password cracking campaigns concurrently across a small private-lab fleet of GPU rigs can't get the rigs to absorb the work without manually breaking campaigns up and pausing them to make room for new ones. Compounding that, they have no unified view of what the fleet is doing — monitoring requires SSH and log parsing per rig.

## Our approach

We win by treating the server as the stateful orchestrator and workers as dumb executors: the server continuously reanalyzes fleet state and campaign progress and assigns the next chunk of work whenever a slot opens. When triggers fire — a rig goes offline mid-priority-work, a campaign's yield decays past a threshold, an operator intervenes — the server can preempt and rebalance in-flight work across rigs.

## Who it's for

**Primary:** Red team operator — They're hiring HashHive to run multiple large, multi-stage cracking campaigns concurrently across the rig fleet and know what's happening, without hand-partitioning keyspaces, sequencing attacks by hand, or SSHing into rigs.

**Secondary:** Infrastructure administrator — keeps the fleet healthy, watches agent connectivity and hardware utilization, troubleshoots agent errors.

## Key metrics

All five are measurable today; tracking discipline is currently weak and improving the measurement plumbing is itself in scope.

- **Fleet utilization** — % of GPU-hours actively cracking vs idle/waiting/erroring. Derivable from agent heartbeats and task assignment state.
- **Operator interventions per campaign** — count of manual pauses, repartitions, priority overrides, or reassignments. Falsifier of the approach — if rebalancing works, this trends toward zero. Needs an intervention event log.
- **Time-to-first-crack** per campaign — wall time from `start` to the first hash falling. Tests DAG pipeline efficiency at the front end. Derivable from `campaigns.started_at` and `hash_items.cracked_at`.
- **Crack yield per GPU-hour** — hashes cracked / (active rigs × hours run) across the fleet. The product's reason for existing.
- **ETA accuracy** — `|predicted_completion − actual_completion| / actual`. Tests whether continuous reanalysis produces trustworthy estimates. Needs both prediction snapshots and actuals captured.

## Tracks

### Scheduler & Campaign Orchestration

The stateful orchestration core: DAG validation, keyspace partitioning, hybrid sync/async task generation (BullMQ for ≥100-task campaigns), pull+notify assignment, heartbeat-driven reassignment, retry and yield-decay logic.

_Why it serves the approach:_ This track IS the guiding choice. Continuous rebalancing across concurrent DAG campaigns lives or dies here.

### Agent Protocol & Fleet Health

The pre-shared-token OpenAPI contract between server and Go-based hashcat agents (sacred — never broken to serve the dashboard), heartbeat and capability detection, error classification (warning vs fatal), batch operations for crack submissions and bulk task reports.

_Why it serves the approach:_ Dumb workers only work if the protocol is rock-solid. The scheduler depends on every agent reporting truthfully and on time.

### Resource Pipeline

Chunked upload (64MB chunks, 100GB+ files), MinIO buckets per resource type, hash-list parsing as async BullMQ job, presigned URLs for direct agent downloads, `hash_items` dedup via unique `(hashListId, hashValue)` constraint.

_Why it serves the approach:_ Complex multi-stage campaigns require multi-GB wordlists, rulelists, and masklists delivered to rigs without buffering. Air-gapped delivery is non-negotiable.

### Operator Console & Real-Time Surface

Campaign Wizard with DAG editor, real-time dashboard via WebSocket with polling fallback, agent/campaign/results detail views, project-scoped event filtering, ETA visualization, results review and CSV export. Analyst work (tuning attacks based on what cracks) lives here — the operator IS the analyst.

_Why it serves the approach:_ Visibility was half the problem statement, and rebalancing triggers need an operator who can see them firing and intercede. The console is where the system shows its thinking.

## Not working on

- Public SaaS deployment of HashHive — never. The product is private-lab only.
- Public agent registry or open agent enrollment — never. Agents are provisioned, not discovered.
- ML-driven attack suggestion — not now. Plausible future direction once the orchestration core is solid and crack-result data has accumulated.
- Cross-instance multi-tenancy or cloud-scale clustering — not now. Single-instance v1 with documented Redis pub/sub extension path for future multi-instance.
- Autonomous-agent peer coordination (Boinc-style) — never. Workers stay dumb; the server stays stateful.
