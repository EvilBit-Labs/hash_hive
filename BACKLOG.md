# Backlog

Companion to [STRATEGY.md](./STRATEGY.md). Orders work by leverage on the strategy's approach (continuous rebalancing + fleet observability) and on the five key metrics, rather than alphabetically or by label.

Work is in two phases:

- **Phase 1 — Foundation:** the 10 remaining tickets under `spec/tickets/`. These complete the original ticket pack and are prerequisite for most of Phase 2.
- **Phase 2 — Backlog:** open GitHub issues (#97–#124) labeled P0/P1/P2 and grouped under epics #117–#121. Strategic-value ordering within tracks.

---

## Phase 1 — Remaining spec/tickets (10)

### Completed (8)

| Ticket                                          | Track                 | Landed                                                                       |
| ----------------------------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `Agent_Authentication_&_Authorization`          | 2 — Agent Protocol    | retrospective                                                                |
| `Agent_Heartbeat_&_Error_Handling`              | 2 — Agent Protocol    | retrospective                                                                |
| `Agent_List_&_Detail_UI`                        | 4 — Operator Console  | retrospective                                                                |
| `BullMQ_Queue_Architecture_&_Redis_Integration` | 1 — Scheduler (infra) | retrospective                                                                |
| `Campaign_Creation_Wizard_UI`                   | 4 — Operator Console  | retrospective                                                                |
| `Campaign_List_&_Detail_UI`                     | 4 — Operator Console  | retrospective                                                                |
| `Campaign_Orchestration_API`                    | 1 — Scheduler         | retrospective                                                                |
| `Resource_Management_API`                       | 3 — Resource Pipeline | PRs #122 / #151 / #152 / #153 / #167 — AC walk complete (issue #157)         |

### Recommended sequence for the remaining 10

Sequencing is strategy-driven, not alphabetical. The scheduler core comes first because it is the guiding choice of the product; resources come second because campaigns can't crack anything without wordlists; visibility and auth follow; results last.

|    # | Ticket                                        | Track                 | Why this order                                                                                                                                                                                                                                                   |
| ---: | --------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | `Task_Distribution_&_Assignment`              | 1 — Scheduler         | **The scheduler is half-done without this.** Strict capability matching, hybrid sync/async generation, reassignment job, retry logic, priority queuing — these *are* the rebalancing approach. Until this lands, campaigns don't actually distribute end-to-end. |
|    2 | `Object_Storage_&_File_Management`            | 3 — Resource Pipeline | Resource API depends on it. Env-driven buckets, presigned URLs, object-store health checks. Now targets SeaweedFS instead of MinIO (Apache-2.0 + MinIO upstream archived). Some chunked-upload code exists from #122 but AC isn't met.                           |
|    3 | `Real-Time_Events_&_WebSocket_Infrastructure` | 4 — Operator Console  | WebSocket auth, polling fallback, project-scoped filtering, connection indicator. #150 shipped partial real-time updates; the full infra ticket has more AC items. Blocks live-update behavior in every Track 4 surface below.                                   |
|    4 | `Project_Selection_&_User_Authentication_API` | 4 — Operator Console  | Project selector endpoint, RBAC enforcement, remember-last-project logic. BetterAuth migration (#127) covers login/logout but the project-scoping AC may still be open.                                                                                          |
|    5 | `Login_&_Project_Selection_UI`                | 4 — Operator Console  | Depends on #4. Auto-select on single-project, remember-last-project, sidebar project switcher, protected route that requires a selected project.                                                                                                                 |
|    6 | `Dashboard_Stats_API_Endpoint`                | 4 — Operator Console  | Backend feed for dashboard cards. `routes/dashboard/stats.ts` exists; verify AC: agent breakdown, campaign breakdown, task breakdown, cracked-hash totals, server-side project scoping.                                                                          |
|    7 | `Dashboard_&_Real-Time_Monitoring_UI`         | 4 — Operator Console  | Depends on #3 + #6. Four stat cards with clickable nav, WebSocket-driven updates, polling fallback, connection indicator.                                                                                                                                        |
|    8 | `Resource_Management_UI`                      | 3 — Resource Pipeline | Backend API (`Resource_Management_API`) shipped — see Completed table. Tabbed resource page, drag-and-drop upload with progress, hash-type detection UI with confidence scores.                                                                                  |
|    9 | `Results_API_&_CSV_Export`                    | 4 — Operator Console  | Paginated/filterable results, CSV export, campaign→attack→hash-list attribution. `routes/dashboard/results.ts` exists; verify AC against ticket.                                                                                                                 |
|   10 | `Results_Analysis_&_Export_UI`                | 4 — Operator Console  | Depends on #9. Global Results page with filters and search, CSV export trigger, campaign-specific results tab on campaign detail.                                                                                                                                |

### Dependency notes

- **#1 (Task Distribution) is on its own track and can be parallelized** against #2–#10 if you have the bandwidth. It blocks nothing in this list but is the highest-leverage item against STRATEGY.md.
- **#3 (WebSocket infra) blocks live-update behavior** in #7, #8, and #10. Finishing it before those UI surfaces avoids re-wiring later.
- **#4 → #5**, **#6 → #7**, **#9 → #10** are hard dependencies. The rest is preference. The `Resource_Management_API → Resource_Management_UI (#8)` dependency is now satisfied by the completed-table entry.

---

## Phase 2 — GitHub issue backlog

Begins after Phase 1 lands. These assume Task Distribution, the Resource Pipeline, and the dashboard surfaces all work end-to-end.

### Cross-cutting infrastructure *(do these before Phase 2 scheduler work)*

| Order |    Issue | Title                                               | Notes                                                                                                                                |
| ----: | -------: | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
|     1 | **#105** | Comprehensive Audit Logging & State Change Tracking | Turns on the *Operator interventions per campaign* metric from STRATEGY.md. Without this, scheduler improvements happen in the dark. |
|     2 | **#106** | Soft Delete Support for Core Models                 | Pairs with the audit story.                                                                                                          |
|     — |     #119 | Epic: Operational Polish                            | Umbrella for #104/#105/#106.                                                                                                         |
|     — |     #117 | Epic: Core Data Flow                                | Cross-track umbrella; consult issue body.                                                                                            |
|     — |     #120 | Epic: Advanced Features                             | Mixed contents; sub-issues land in matching tracks.                                                                                  |

### Track 1 — Scheduler & Campaign Orchestration *(highest leverage)*

| Order |    Issue | Title                                                             | Notes                                                     |
| ----: | -------: | ----------------------------------------------------------------- | --------------------------------------------------------- |
|     1 | **#100** | Campaign ETA Calculator Service                                   | 3 SP. Powers ETA accuracy metric from STRATEGY.md.        |
|     2 |  **#97** | Task Preemption for Priority-Based Workload Balancing             | P0. Makes the strategy's "mode B" rebalance trigger real. |
|     3 |  **#99** | Attack Complexity Calculation & State Machine                     | Feeds keyspace + ETA.                                     |
|     4 | **#103** | Advanced Attack Types (Combinator, Association, PRINCE, Keyboard) | Sequence after #99.                                       |
|     — |     #115 | Attack Playbooks — Grouped Template Deployment                    | P2. Defer.                                                |
|     — |     #118 | Epic: Intelligent Scheduling                                      | Umbrella for #97/#99/#100/#103.                           |

### Track 2 — Agent Protocol & Fleet Health

| Order |    Issue | Title                                             | Notes                                                             |
| ----: | -------: | ------------------------------------------------- | ----------------------------------------------------------------- |
|     1 | **#104** | Agent Advanced Configuration & Error Whitelisting | Unblocks operator manual triage.                                  |
|     — |     #111 | Agent API v2 — Modern Idiomatic Design            | P2. Wait for #103-class changes to settle; v1 contract is sacred. |
|     — |     #114 | Bulk Agent Enrollment via Voucher Codes           | P2. Agents are provisioned, not discovered (per STRATEGY.md).     |

### Track 3 — Resource Pipeline

| Order |    Issue | Title                                                       | Notes                            |
| ----: | -------: | ----------------------------------------------------------- | -------------------------------- |
|     1 | **#108** | File Integrity Verification & Intelligent Distribution      | 3 SP. Real risk at 100GB+ scale. |
|     2 | **#101** | SuperHashlists — Cross-Hashlist Deduplication               | Crack-yield improvement.         |
|     3 | **#102** | Hash List Export, Pre-Cracked Import & Global Search        | Bridges Track 3 and Track 4.     |
|     — |     #112 | Crackable Uploads — Auto Hash Detection & Attack Generation | P2. Defer.                       |
|     — |     #113 | Inline Resource Editing in Browser                          | P2. Defer.                       |

### Track 4 — Operator Console & Real-Time Surface

| Order |    Issue | Title                                                  | Notes                                                                |
| ----: | -------: | ------------------------------------------------------ | -------------------------------------------------------------------- |
|     1 | **#110** | Historical Performance Graphs & Analytics              | Pairs with #100; lets operators see rebalancing decisions over time. |
|     2 | **#107** | Webhook Notification System with Configurable Triggers | Async out-of-band alerting once #110 surfaces events.                |
|     — |     #121 | Epic: Visualization & Stretch                          | Umbrella; includes #110.                                             |
|     — |     #116 | TUI Interface for Headless Operations                  | P2. Alt console; defer.                                              |
|     — |     #124 | feat: AD/LDAP authentication support                   | No movement on any strategy metric.                                  |

---

## How to use this doc

- **Working through Phase 1?** Pick the next item from the Phase 1 sequence table. Don't go alphabetical.
- **Phase 1 complete?** Start with **#105 + #106** (audit + soft delete) before any Phase 2 scheduler work, so the metrics light up.
- **Re-rank when STRATEGY.md changes** or when a metric becomes a real bottleneck.
- **Items below the `—` line** in each track are real work, not killed work. Parked until the strategy makes them load-bearing.
- **Add new issues** to the matching track; promote into the ordered section when they outrank current candidates.
