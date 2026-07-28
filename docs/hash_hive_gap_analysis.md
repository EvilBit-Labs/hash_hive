# hash_hive Gap Analysis: CipherSwarm Parity & Ouroboros Stretch Goals

> Generated 2026-03-25 by comparing CipherSwarm (Rails), hash_hive (TypeScript/Bun), and Ouroboros (FastAPI/SvelteKit).
>
> **Purpose:** This document identifies every functional gap between hash_hive and CipherSwarm, plus stretch goals from Ouroboros. Each gap is described with enough context for a coding assistant to understand what needs to be built, and is ready to be filed as a GitHub issue on `EvilBit-Labs/hash_hive`.

---

## How to Use This Document

**For tracking work:** Each gap below is a self-contained issue definition. Use Claude Code or `gh` CLI to create GitHub issues from them.

**For coding assistants:** This document can be placed in hash_hive's `docs/` directory or referenced from `CLAUDE.md`. Each gap includes CipherSwarm references, what hash_hive needs, and acceptance criteria.

**Priority tiers:**

| Tier | Meaning | Count |
|------|---------|-------|
| **P0** | Core parity blocker — CipherSwarm has it, hash_hive needs it to be a functional distributed cracking platform | 6 |
| **P1** | Important feature — CipherSwarm has it, high operational value | 12 |
| **P2** | Stretch goal — Ouroboros vision, beyond CipherSwarm | 6 |

**Suggested labels for GitHub issues:**

- Priority: `P0: parity-blocker` (red), `P1: important` (orange), `P2: stretch-goal` (yellow)
- Feature area: `agent-management`, `campaign-management`, `task-distribution`, `hash-management`, `resource-management`, `monitoring`, `api`, `audit-compliance`
- Source: `gap-analysis`

---

## P0: Core Parity Blockers

### P0-1: Agent Benchmarking & Performance Profiling System

**Labels:** `P0: parity-blocker`, `agent-management`, `gap-analysis`, `enhancement`, `backend`

#### Context

CipherSwarm has a full agent benchmarking system that hash_hive currently lacks. Benchmarks are central to intelligent task assignment — without knowing each agent's per-hash-type throughput, the scheduler can't optimally distribute work.

#### CipherSwarm Reference

- **HashcatBenchmark model** (6.4 KB): Stores per-agent, per-hash-type benchmark results
- **Agent state machine**: `pending → active → benchmarked → error/stopped` — agents aren't fully operational until benchmarked
- **API endpoint**: `POST /api/v1/client/agents/{id}/submit_benchmark`
- **Benchmark progress indicator**: CipherSwarm issue #613
- **Incremental benchmark submission**: CipherSwarm issue #612

#### What hash_hive Needs

1. **Benchmark data model** — Store per-agent, per-hash-type throughput (hashes/sec) with hardware context
2. **Agent state machine enhancement** — Add `benchmarked` state; agents should benchmark before accepting tasks
3. **Agent API endpoint** — Agents submit benchmark results after registration
4. **Benchmark-aware task assignment** — Feed benchmark data into the task scheduler for proportional keyspace chunks
5. **Dashboard display** — Show benchmark results per agent (table of hash types × throughput)

#### Acceptance Criteria

- [ ] Agents can submit benchmark results via API
- [ ] Benchmark data is persisted per agent per hash type
- [ ] Agent state machine reflects benchmark status
- [ ] Task scheduler considers benchmark data when assigning work
- [ ] Dashboard shows agent benchmark results

#### Related hash_hive Issues

- #19 (Agent Management System)
- #37 (Agent API Epic)

---

### P0-2: Cracker Binary Management & Agent Auto-Update

**Labels:** `P0: parity-blocker`, `agent-management`, `gap-analysis`, `enhancement`, `backend`

#### Context

CipherSwarm tracks hashcat binary versions and provides an auto-update mechanism. This ensures all agents run compatible cracker versions and can be updated centrally rather than touching each rig manually.

#### CipherSwarm Reference

- **CrackerBinary model**: Tracks hashcat versions, binaries per OS/architecture
- **API endpoint**: `GET /api/v1/client/crackers/check_for_cracker_update`
- **CrackersController** (91 lines): Serves binary metadata and download info
- **OperatingSystem model**: OS/architecture combinations for binary matching
- **Admin interface**: Upload and manage cracker binary versions

#### What hash_hive Needs

1. **Cracker binary registry** — Model to track hashcat versions with platform-specific binaries
2. **Binary storage** — Store cracker binaries in MinIO
3. **Agent API endpoint** — Version check + presigned download URL
4. **Version tracking** — Record which hashcat version each agent runs
5. **Dashboard management** — UI for uploading new cracker releases

#### Acceptance Criteria

- [ ] Server tracks cracker binary versions per platform
- [ ] Agents check for updates via API and download via presigned URLs
- [ ] Dashboard shows per-agent cracker version
- [ ] Admin can upload new cracker versions

#### Related hash_hive Issues

- #37 (Agent API Epic), #19 (Agent Management System)

---

### P0-3: Attack Templates — Reusable Attack Definitions

**Labels:** `P0: parity-blocker`, `campaign-management`, `gap-analysis`, `enhancement`

#### Context

CipherSwarm has reusable Attack Templates (attack type + parameters + resource references) that can be applied to different hash lists without reconfiguring from scratch. Essential for operational efficiency when running standardized strategies across campaigns.

#### CipherSwarm Reference

- **Template model**: Stores attack type, hashcat parameters, resource references
- **Template → Attack instantiation**: Templates pre-fill concrete Attacks within a Campaign
- **Web UI**: Create, edit, browse, and apply templates

#### What hash_hive Needs

1. **Template data model** — attack mode, resource references, hashcat parameters, name/description
2. **Template CRUD API** — Dashboard endpoints for template management
3. **Template instantiation** — Select a template when creating campaign attacks to pre-fill config
4. **Campaign wizard integration** — Offer template selection as a starting point
5. **Project scoping** — Templates follow multi-tenancy model

#### Acceptance Criteria

- [ ] Templates can be created, listed, edited, deleted via API
- [ ] Template stores: name, description, attack mode, hashcat params, resource refs
- [ ] Campaign wizard supports template selection
- [ ] Templates are project-scoped

#### Related hash_hive Issues

- #22 (Campaign and Attack Management), #28 (Campaign Creation Wizard)

---

### P0-4: Keyspace-Based Task Distribution with Dynamic Chunking

**Labels:** `P0: parity-blocker`, `task-distribution`, `gap-analysis`, `enhancement`, `backend`

#### Context

**This is the single most critical gap.** CipherSwarm's TaskAssignmentService (18.9 KB) divides attack keyspace across agents proportional to their capabilities. hash_hive has BullMQ task queuing but no keyspace-aware distribution.

#### CipherSwarm Reference

- **TaskAssignmentService** (18.9 KB): Core scheduling with diagnostics and skip-reason tracking
- **Keyspace partitioning**: Chunk sizes proportional to agent benchmark throughput
- **Task claim fields**: `claimed_at`, `claimed_by_agent_id` for atomic claiming
- **CipherSwarm issue #622**: priority:critical, effort:large

#### What hash_hive Needs

1. **Keyspace calculation** — Total keyspace per attack based on mode, wordlist sizes, rule counts, mask length
2. **Dynamic chunk sizing** — Divide keyspace proportional to agent benchmarks (depends on P0-1 benchmark system)
3. **Atomic task claiming** — Prevent double-assignment (note GOTCHAS.md: no native `FOR UPDATE SKIP LOCKED` in Drizzle — use `db.execute(sql\`...\`)`)
4. **Progress tracking** — Track keyspace offset/limit/completed per task
5. **Dynamic rebalancing** — Redistribute remaining keyspace when fleet changes
6. **Diagnostic logging** — Log assignment decisions for debugging

#### Acceptance Criteria

- [ ] Attacks divided into keyspace-based task chunks
- [ ] Chunk sizes account for agent benchmark data
- [ ] Atomic task claiming (no double-assignment)
- [ ] Progress tracked as keyspace units
- [ ] Remaining keyspace redistributable on fleet changes

#### Technical Notes

- GOTCHAS.md: no native `FOR UPDATE SKIP LOCKED` in Drizzle ORM — use `db.execute(sql\`...\`)`
- Circular import `campaigns.ts ↔ tasks.ts` — use `_deps` injection pattern

#### Related hash_hive Issues

- #23 (Task Distribution System)
- **Depends on:** P0-1 (Agent Benchmarking)

---

### P0-5: Task Preemption for Priority-Based Workload Balancing

**Labels:** `P0: parity-blocker`, `task-distribution`, `gap-analysis`, `enhancement`, `backend`

#### Context

Without preemption, a low-priority campaign running on all agents blocks newly created high-priority campaigns from getting any resources. CipherSwarm solves this with a dedicated preemption service.

#### CipherSwarm Reference

- **TaskPreemptionService** (7.1 KB): Priority-based workload balancing algorithm
- **CampaignPriorityRebalanceJob**: Event-driven trigger on priority changes
- **Preemption tracking fields** in database
- **Task transitions**: `running → paused` (preempted), `paused → running` (resumed)

#### What hash_hive Needs

1. **Preemption algorithm** — Identify lower-priority running tasks to pause for higher-priority work
2. **Preemption-aware task states** — `paused` state with reason tracking (preempted vs user-initiated)
3. **Event-driven trigger** — Evaluate preemption on priority changes and new campaign starts
4. **Agent notification** — Tell preempted agents to stop and pick up new work
5. **Resume logic** — Preempted tasks become eligible when high-priority work completes
6. **Audit trail** — Track what was preempted, when, why

#### Acceptance Criteria

- [ ] Higher-priority campaigns preempt lower-priority running tasks
- [ ] Preempted tasks are paused (not cancelled) and can resume
- [ ] Preemption triggered by priority changes and new campaign starts
- [ ] Agents notified to stop preempted work
- [ ] Preemption events logged

#### Related hash_hive Issues

- #23 (Task Distribution System)
- Closely related to P0-4 (Keyspace Distribution)

---

### P0-6: Hash Item Storage, Crack Result Tracking & Zap System

**Labels:** `P0: parity-blocker`, `hash-management`, `gap-analysis`, `enhancement`, `backend`

#### Context

This is the core data flow that makes a distributed cracking platform useful: agents submit cracks, the server records them, and other agents are told not to waste time on already-cracked hashes ("zaps").

#### CipherSwarm Reference

- **HashItem model**: Individual hashes with cracked/uncracked status and plaintext
- **HashcatGuess model**: Cracked password records
- **CrackSubmissionService** (6.2 KB), **StatusSubmissionService** (6.2 KB)
- **HashcatStatus model** (12.4 KB): Rich status data from running attacks
- **API endpoints**: `submit_crack`, `submit_status`, `get_zaps`
- **CipherSwarm issue #623**: Live zap system for cross-hashlist dedup

#### What hash_hive Needs

1. **Hash item model** — Individual records: hash value, salt, cracked status, plaintext, cracked_at, cracked_by_agent
2. **Crack submission endpoint** — Agent API for hash:plaintext pairs
3. **Status submission endpoint** — Agent API for speed, progress, temperature, ETA
4. **Zap endpoint** — Agent fetches hashes cracked since last check (skip solved hashes)
5. **Result aggregation** — Dashboard views for results per campaign/hash list
6. **Progress calculation** — Derive progress from cracked/total counts

#### Acceptance Criteria

- [ ] Individual hashes stored and tracked within hash lists
- [ ] Agents submit crack results and status updates via API
- [ ] Agents fetch "zaps" — hashes cracked by others
- [ ] Dashboard shows crack results and progress
- [ ] Campaign progress derived from hash item status

#### Related hash_hive Issues

- #21 (Hash Analysis Service), #22 (Campaign and Attack Management)

---

## P1: Important CipherSwarm Features

### P1-1: Attack Complexity Calculation & State Machine

**Labels:** `P1: important`, `campaign-management`, `gap-analysis`, `enhancement`, `backend`

#### CipherSwarm Reference

- **Attack model** (15.3 KB): State machine `pending → running → completed/exhausted/failed/paused`
- **CalculateMaskComplexityJob**: Background job for mask attack complexity
- Complexity enables progress bars, ETA display, keyspace reporting

#### What hash_hive Needs

1. **Attack-level state machine** — Independent lifecycle per attack within a campaign
2. **Complexity calculation** — Estimate total keyspace/duration per attack type
3. **Background job** — Async complexity calculation for large attacks
4. **Progress integration** — Feed complexity into progress bars and ETA

#### Related hash_hive Issues

- #22 (Campaign and Attack Management)

---

### P1-2: Campaign ETA Calculator Service

**Labels:** `P1: important`, `campaign-management`, `gap-analysis`, `enhancement`, `backend`

#### CipherSwarm Reference

- **CampaignETACalculator** (5.9 KB): Uses attack complexity, agent throughput, remaining keyspace, historical performance

#### What hash_hive Needs

1. **ETA service** — Estimate campaign completion from current throughput + remaining keyspace + fleet size
2. **Per-attack ETA** — Breakdown by individual attacks
3. **Dashboard integration** — Display on campaign list and detail views
4. **Real-time recalculation** — Update as status arrives via WebSocket

#### Related hash_hive Issues

- #22 (Campaign and Attack Management), #27 (Dashboard and Real-time Monitoring)

---

### P1-3: SuperHashlists — Cross-Hashlist Deduplication ✅ IMPLEMENTED

**Labels:** `P1: important`, `hash-management`, `gap-analysis`, `enhancement`

**Status:** Implemented in PR #307 (#101)

#### Implementation Reference

- **PR #307** (feat(super): SuperHashlists — cross-hashlist deduplication): Two-layer implementation: project-wide crack-once via `project_cracked_hashes` set + virtual SuperHashlist entity (`super_hash_lists` + `super_hash_list_members`)
- **Requirements:** `docs/brainstorms/2026-07-26-superhashlists-cross-hashlist-deduplication-requirements.md`

#### CipherSwarm Reference

- **Issue #634** (epic, priority:high): Deduplicate cracking across multiple hashlists of same type

#### What hash_hive Needs *(completed)*

1. **SuperHashlist model** — Virtual hash list unioning multiple lists of the same type ✅
2. **Deduplication engine** — Merge duplicate hashes across lists ✅
3. **Result propagation** — Crack in super list → mark in all source lists ✅
4. **Campaign integration** — Run campaigns against a SuperHashlist ✅

**Depends on:** P0-6 (Hash Item Storage)

#### Related hash_hive Issues

- #21 (Hash Analysis Service)

---

### P1-4: Hash List Export, Pre-Cracked Import & Global Search

**Labels:** `P1: important`, `hash-management`, `gap-analysis`, `enhancement`

#### CipherSwarm Reference

- **Issue #625** (export), **#635** (import pre-cracked), **#624** (global search)

#### What hash_hive Needs

1. **Export** — Cracked pairs (hash:plain), recovered passwords only, or uncracked hashes. CSV and potfile formats.
2. **Import pre-cracked** — Import hash:plain pairs from external tools/potfiles to mark hashes solved.
3. **Global search** — Search for a hash across all hash lists in a project (or globally).

**Depends on:** P0-6 (Hash Item Storage)

#### Related hash_hive Issues

- #21 (Hash Analysis Service)

---

### P1-5: Advanced Attack Types: Combinator, Association, PRINCE & Keyboard Layouts

**Labels:** `P1: important`, `campaign-management`, `gap-analysis`, `enhancement`

#### CipherSwarm Reference

- **Issue #632**: Combinator (mode 1) and association (mode 9) with multi-wordlist support
- **Issue #631**: PRINCE preprocessor framework with custom processor support
- **Issue #659**: Keyboard layout mapping (.hckmap) files in dictionary attacks

#### What hash_hive Needs

1. **Combinator attack (mode 1)** — UI and API for two-wordlist combinator attacks
2. **Association attack (mode 9)** — UI and API support
3. **Preprocessor framework / PRINCE** — Support for PRINCE and custom preprocessors
4. **Keyboard layout mapping (.hckmap)** — File upload and association with dictionary attacks

#### Related hash_hive Issues

- #22 (Campaign and Attack Management)

---

### P1-6: Agent Advanced Configuration & Error Whitelisting

**Labels:** `P1: important`, `agent-management`, `gap-analysis`, `enhancement`

#### CipherSwarm Reference

- **AdvancedConfiguration model**: Per-agent hashcat settings
- **Issue #633**: Error whitelisting for non-critical runtime errors
- **Issue #658**: Proper selectors for agent hashcat config

#### What hash_hive Needs

1. **Advanced configuration model** — Per-agent: workload profile, device selection, temperature limits, optimized kernels, custom flags
2. **Configuration UI** — Proper selectors (not free-text) for hashcat parameters
3. **Error whitelisting** — Mark specific hashcat error patterns as non-critical
4. **Config inheritance** — Default at project level, override per agent

#### Related hash_hive Issues

- #19 (Agent Management System)

---

### P1-7: Comprehensive Audit Logging & State Change Tracking

**Labels:** `P1: important`, `audit-compliance`, `gap-analysis`, `enhancement`, `backend`

#### CipherSwarm Reference

- **Audited gem**: Tracks all model changes (who, what, when, old/new values)
- **StateChangeLogger service** (6.2 KB): Dedicated state transition logging

#### What hash_hive Needs

1. **Audit trail** — Log significant data changes with actor, timestamp, old/new values
2. **State change logging** — Dedicated logging for campaign/attack/task/agent transitions with reason
3. **Queryable audit log** — API and dashboard view for browsing history
4. **Retention policy** — Configurable retention period

---

### P1-8: Soft Delete Support for Core Models

**Labels:** `P1: important`, `audit-compliance`, `gap-analysis`, `enhancement`, `backend`

#### CipherSwarm Reference

- **Paranoia gem**: Soft deletes across all major models

#### What hash_hive Needs

1. **Soft delete columns** — `deletedAt` on campaigns, attacks, hash lists, resources, agents
2. **Query filtering** — Default queries exclude deleted; admin can view
3. **Restore capability** — API to un-delete records
4. **Cascade behavior** — Soft-delete cascade rules
5. **Cleanup job** — Permanently delete past retention period

---

### P1-9: Webhook Notification System with Configurable Triggers

**Labels:** `P1: important`, `api`, `gap-analysis`, `enhancement`

#### CipherSwarm Reference

- **Issue #627**: Webhook-based notifications with configurable triggers

#### What hash_hive Needs

1. **Webhook registration** — Users configure URLs + event filters per project
2. **Event triggers** — Campaign completed, hash cracked, agent error, task failed
3. **Delivery system** — Reliable delivery with retry and failure tracking
4. **Payload format** — Structured JSON with event type, timestamp, data
5. **Dashboard management** — UI for webhook config and delivery history

#### Use Cases

- Slack/Discord notifications on campaign completion
- External automation pipeline integration
- Agent failure alerts

---

### P1-10: File Integrity Verification & Intelligent Distribution

**Labels:** `P1: important`, `resource-management`, `gap-analysis`, `enhancement`, `backend`

#### CipherSwarm Reference

- **VerifyChecksumJob**: Background checksum verification
- **Issue #630**: Compression and caching for agent distribution

#### What hash_hive Needs

1. **Checksums** — Compute and store SHA-256 for all uploaded resources; verify on download
2. **Integrity job** — Background verification of stored files
3. **Compression** — Compress large resources for distribution; decompress on agent
4. **Caching** — ETags/checksums so agents skip re-downloads
5. **Agent API integration** — Include checksum in download response

#### Related hash_hive Issues

- #20 (Resource Management System)

---

### P1-11: System Health Monitoring Service

**Labels:** `P1: important`, `monitoring`, `gap-analysis`, `enhancement`, `backend`

#### CipherSwarm Reference

- **SystemHealthCheckService** (9.5 KB): Monitors PostgreSQL, Redis, Sidekiq
- **SystemHealthController**: Health API endpoint
- **SystemHealthCardComponent**: Dashboard widget

#### What hash_hive Needs

1. **Health check service** — Monitor PostgreSQL, Redis, MinIO, BullMQ workers
2. **Health API** — `/api/v1/health` with per-component status
3. **Dashboard widget** — Health card with green/yellow/red indicators
4. **Background monitoring** — Periodic checks via BullMQ scheduled job
5. **Alert thresholds** — Disk space, queue depth, connection pool

#### Related hash_hive Issues

- #27 (Dashboard and Real-time Monitoring)

---

### P1-12: Historical Performance Graphs & Analytics

**Labels:** `P1: important`, `monitoring`, `gap-analysis`, `enhancement`, `frontend`

#### CipherSwarm Reference

- **Issue #626**: Historical performance graphs for agents and tasks

#### What hash_hive Needs

1. **Time-series storage** — Agent hash rates, task throughput, campaign progress over time
2. **Rolling trends** — 8-hour (configurable) rolling hash rate view
3. **Campaign history** — Cracks over time, speed trends, completion curves
4. **Agent comparison** — Side-by-side throughput graphs
5. **Dashboard charts** — Recharts-based visualizations (already in frontend deps)

#### Related hash_hive Issues

- #27 (Dashboard and Real-time Monitoring)

---

## P2: Ouroboros Stretch Goals

### P2-1: Agent API v2 — Modern Idiomatic Design

**Labels:** `P2: stretch-goal`, `agent-management`, `api`, `gap-analysis`, `enhancement`

#### Context

Ouroboros planned an Agent API v2 (issue #18, epic) that breaks from v1 legacy constraints for modern patterns.

#### What hash_hive Would Need

1. **API versioning** — Support `/api/v1/agent/*` and `/api/v2/agent/*` simultaneously
2. **Modern auth** — JWT or mTLS instead of pre-shared tokens
3. **Rate limiting** — Per-agent rate limits
4. **OpenAPI-first design** — Contract-first v2 specification
5. **Migration path** — Agents upgrade from v1 to v2 incrementally

#### Related

- Ouroboros issues #15-#25

---

### P2-2: Crackable Uploads — Auto Hash Detection & Attack Generation

**Labels:** `P2: stretch-goal`, `gap-analysis`, `enhancement`, `feature`

#### Context

Ouroboros envisions uploading hashes → auto-detect type → auto-generate recommended campaign. Dramatically lowers barrier to entry.

#### What hash_hive Would Need

1. **Auto-detection pipeline** — Run name-that-hash (partially exists) and auto-set hash type
2. **Attack recommendation engine** — Recommend standard strategies for detected hash type
3. **One-click campaign creation** — Upload → detect → recommend → launch in a single flow
4. **Smart defaults** — Pre-configured templates for common hash types (NTLM, bcrypt, SHA-256)
5. **Confirmation UI** — Show auto-detected config, let user adjust before launch

#### Related hash_hive Issues

- #21 (Hash Analysis Service), #28 (Campaign Creation Wizard)
- **Depends on:** P0-3 (Attack Templates)

---

### P2-3: Inline Resource Editing in Browser

**Labels:** `P2: stretch-goal`, `resource-management`, `gap-analysis`, `enhancement`, `frontend`

#### Context

Resources are upload-only. Ouroboros envisions editing wordlists, masks, and rules directly in the browser.

#### What hash_hive Would Need

1. **Text editor component** — Monaco or CodeMirror for viewing/editing
2. **Streaming read** — Stream from MinIO; virtual scroll for large files
3. **Save-back** — Write edits to MinIO, update metadata (lines, size, checksum)
4. **Size limits** — Inline edit only below threshold (e.g., 10MB); read-only preview for larger
5. **Syntax awareness** — Highlighting for mask and rule syntax

#### Related hash_hive Issues

- #30 (Resource Management Web UI)

---

### P2-4: Bulk Agent Enrollment via Voucher Codes

**Labels:** `P2: stretch-goal`, `agent-management`, `gap-analysis`, `enhancement`

#### CipherSwarm Reference

- **Issue #629**: Voucher-based batch enrollment

#### What hash_hive Would Need

1. **Voucher code model** — Single-use or multi-use codes with expiry
2. **Enrollment endpoint** — Agents present voucher for initial registration
3. **Management UI** — Create, list, revoke vouchers
4. **Project binding** — Vouchers scoped to a project
5. **Usage tracking** — Which agents used which voucher

#### Related hash_hive Issues

- #19 (Agent Management System)

---

### P2-5: Attack Playbooks — Grouped Template Deployment

**Labels:** `P2: stretch-goal`, `campaign-management`, `gap-analysis`, `enhancement`

#### CipherSwarm Reference

- **Issue #628**: Deploy groups of attack templates together

#### What hash_hive Would Need

1. **Playbook model** — Ordered collection of attack templates with optional DAG dependencies
2. **Playbook CRUD** — Create, edit, clone, delete
3. **Deployment** — Apply playbook to hash list → auto-create campaign with all attacks
4. **Sharing** — Project-scoped or cross-project
5. **Import/export** — JSON format for community sharing

**Depends on:** P0-3 (Attack Templates)

#### Related hash_hive Issues

- #22 (Campaign and Attack Management)

---

### P2-6: TUI Interface for Headless Operations

**Labels:** `P2: stretch-goal`, `gap-analysis`, `enhancement`, `feature`

#### Context

Ouroboros envisions a terminal UI for operators who prefer CLI or need headless access (SSH, no browser).

#### What hash_hive Would Need

1. **Control API** (prerequisite — hash_hive #25/#38) — Machine-readable REST API
2. **TUI framework** — Ink (Node.js), or separate Go/Rust binary
3. **Core views** — Dashboard summary, campaign list/detail, agent status, results stream
4. **Interactive ops** — Create campaigns, manage agents, pause/resume
5. **Live updates** — WebSocket or polling for real-time terminal display

**Depends on:** Control API (hash_hive #25/#38)

#### Related hash_hive Issues

- #25 (Control API), #38 (Control API Epic)

---

## Dependency Graph

```
P0-1 (Benchmarking) ──┐
                       ├──► P0-4 (Keyspace Distribution)
P0-6 (Hash Items)  ───┤
                       ├──► P0-5 (Task Preemption)
                       │
                       ├──► P1-1 (Attack Complexity)
                       ├──► P1-2 (Campaign ETA)
                       ├──► P1-3 (SuperHashlists)
                       └──► P1-4 (Export/Import/Search)

P0-3 (Templates)  ────┬──► P2-2 (Crackable Uploads)
                       └──► P2-5 (Attack Playbooks)

hash_hive #25/#38 ────► P2-6 (TUI Interface)
(Control API)
```

## Recommended Implementation Order

**Phase 1 — Foundation (P0, do first):**

1. P0-6: Hash Item Storage & Crack Results (unlocks progress tracking, zaps)
2. P0-1: Agent Benchmarking (unlocks intelligent distribution)
3. P0-3: Attack Templates (unlocks operational efficiency)
4. P0-4: Keyspace Distribution (core scheduling — depends on P0-1)
5. P0-5: Task Preemption (depends on P0-4)
6. P0-2: Cracker Binary Management (independent, can parallel with above)

**Phase 2 — Operational Polish (P1):**
7. P1-1: Attack Complexity & State Machine
8. P1-2: Campaign ETA Calculator
9. P1-11: System Health Monitoring
10. P1-7: Audit Logging
11. P1-8: Soft Deletes
12. P1-10: File Integrity
13. P1-6: Agent Advanced Config
14. P1-12: Historical Graphs
15. P1-4: Hash Export/Import/Search
16. P1-3: SuperHashlists
17. P1-5: Advanced Attack Types
18. P1-9: Webhooks

**Phase 3 — Stretch (P2):**
19. P2-2: Crackable Uploads
20. P2-5: Attack Playbooks
21. P2-3: Inline Resource Editing
22. P2-4: Bulk Agent Enrollment
23. P2-1: Agent API v2
24. P2-6: TUI Interface
