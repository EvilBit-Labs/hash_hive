# Backlog

Companion to [STRATEGY.md](./STRATEGY.md). Orders work by leverage on the strategy's approach (continuous rebalancing + fleet observability) and on the five key metrics, rather than alphabetically or by label.

All work nests under GitHub super-epic **#166 — Phase 1 Foundation**, which tracks both phases as nested children. See [Epic hierarchy](#epic-hierarchy-super-epic-166) for the full tree.

Work is in two phases:

- **Phase 1 — Foundation:** ✅ **COMPLETE.** The original ticket pack shipped as issues #155–#165 (plus Resource Management API #157). All closed.
- **Phase 2 — Backlog:** open GitHub issues grouped under sub-epics #118–#121. Epic #117 (Core Data Flow) is closed as delivered. Strategic-value ordering within tracks.

---

## Epic hierarchy (super-epic #166)

`#166` is the master tracker. Its native sub-issues are the Phase 1 step-issues (#155–#165), the standalone migration tool (#154), and the data-flow + Phase 2 sub-epics (#117–#121):

```text
#166  Phase 1 Foundation — Scheduler Core, Resource Pipeline & Operator Console
├── Phase 1 step-issues #155–#165 .................... ✅ all closed
├── #154  CipherSwarm → HashHive migration tool ...... open (standalone)
├── #117  Core Data Flow ............................. ✅ closed (delivered)
├── #118  Intelligent Scheduling .................... ✅ closed (3/3: #96, #97, #99 delivered)
├── #119  Operational Polish ....................... 0/7  → open: #100, #102, #104, #105, #106, #108, #124
├── #120  Advanced Features ........................ 1/4  → open: #101, #103, #107
└── #121  Visualization & Stretch .................. 0/7  → open: #110, #111, #112, #113, #114, #115, #116
```

> **Membership is authoritative from GitHub native sub-issue links, not from issue-body prose.** The track tables below order the same issues by strategic leverage; the epic each issue lives under is shown here.

### Recently captured under #166

These were filed after the epic structure was set and initially sat outside any epic. They have since been linked under #166 (directly or via a sub-epic); recorded here so the placement rationale stays visible. **No open issue remains outside the #166 tree.**

| Issue | Title | Linked under |
|------:|-------|--------------|
| #182 | Agent API zaps endpoint composite cursor (stable pagination) | #119 (hash pipeline hardening) |
| #197 | Dashboard server-side sparkline history endpoint | #121 (Visualization) — pairs with #110 |
| #201 | E2E: commit + unskip Linux Playwright visual baseline | #166 direct (CI/test closeout) |
| #202 | Detect mixed hash types in hash lists and auto-split | #119 (hash management) |
| #207 | Testcontainers integration tests for Results filters + scoping | #166 direct (test coverage for #164) |
| #211 | Interactive DAG visualization for campaign status | #121 (Visualization & Stretch) |

---

## Phase 1 — Foundation ✅ COMPLETE

Every Phase 1 ticket shipped as an issue nested under super-epic #166 — step-issues #155–#165 plus the Resource Management API (#157). Nothing remains in this phase. The strategy-driven sequence (scheduler core first, then resources, then visibility/auth, results last) is preserved here for the record.

| Step | Issue | Ticket                                        | Track                 |
| ---: | ----- | --------------------------------------------- | --------------------- |
|    1 | #155  | `Task_Distribution_&_Assignment`              | 1 — Scheduler         |
|    2 | #156  | `Object_Storage_&_File_Management`            | 3 — Resource Pipeline |
|    — | #157  | `Resource_Management_API`                     | 3 — Resource Pipeline |
|    3 | #158  | `Real-Time_Events_&_WebSocket_Infrastructure` | 4 — Operator Console  |
|    4 | #159  | `Project_Selection_&_User_Authentication_API` | 4 — Operator Console  |
|    5 | #160  | `Login_&_Project_Selection_UI`                | 4 — Operator Console  |
|    6 | #161  | `Dashboard_Stats_API_Endpoint`                | 4 — Operator Console  |
|    7 | #162  | `Dashboard_&_Real-Time_Monitoring_UI`         | 4 — Operator Console  |
|    8 | #163  | `Resource_Management_UI`                      | 3 — Resource Pipeline |
|    9 | #164  | `Results_API_&_CSV_Export`                    | 4 — Operator Console  |
|   10 | #165  | `Results_Analysis_&_Export_UI`                | 4 — Operator Console  |

The retrospective foundation work (agent auth, heartbeat, BullMQ + Redis, campaign orchestration, and the campaign/agent list+detail and creation-wizard UIs) also landed and is folded into the surfaces above.

---

## Phase 2 — GitHub issue backlog

Begins after Phase 1 lands. These assume Task Distribution, the Resource Pipeline, and the dashboard surfaces all work end-to-end.

### Cross-cutting infrastructure *(do these before Phase 2 scheduler work)*

| Order |    Issue | Title                                               | Notes                                                                                                                                |
| ----: | -------: | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
|     1 | **#105** | Comprehensive Audit Logging & State Change Tracking | Turns on the *Operator interventions per campaign* metric from STRATEGY.md. Without this, scheduler improvements happen in the dark. |
|     2 | **#106** | Soft Delete Support for Core Models                 | Pairs with the audit story.                                                                                                          |
|     — |     #119 | Epic: Operational Polish                            | GitHub children: #100, #102, #104, #105, #106, #108, #124.                                                                          |
|     — |     #120 | Epic: Advanced Features                             | GitHub children: #38 (closed), #101, #103, #107.                                                                                     |

> Epic **#117 (Core Data Flow)** is **closed as delivered** — its P0 pipeline (benchmarking #93, cracker binaries #94, attack templates #95, hash storage/crack/zap #98, plus #109 health and #126 BetterAuth) all shipped.

### Track 1 — Scheduler & Campaign Orchestration *(highest leverage)*

| Order |    Issue | Title                                                             | Notes                                                     |
| ----: | -------: | ----------------------------------------------------------------- | --------------------------------------------------------- |
|     1 | **#100** | Campaign ETA Calculator Service                                   | 3 SP. Powers ETA accuracy metric from STRATEGY.md.        |
|     ✅ |  **#97** | Task Preemption for Priority-Based Workload Balancing             | ✅ Delivered (closed). The strategy's "mode B" rebalance trigger is now real. |
|     ✅ |  **#99** | Attack Complexity Calculation & State Machine                     | ✅ Delivered (closed). Feeds keyspace + ETA. |
|     4 | **#103** | Advanced Attack Types (Combinator, Association, PRINCE, Keyboard) | Sequence after #99.                                       |
|     — |     #115 | Attack Playbooks — Grouped Template Deployment                    | P2. Defer.                                                |
|     ✅ |     #118 | Epic: Intelligent Scheduling                                      | ✅ Delivered. All children closed (#96, #97, #99); epic closing via wrap-up PR. (#100 lives under #119, #103 under #120 — grouped here by scheduler leverage.) |

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
|     — |     #121 | Epic: Visualization & Stretch                          | GitHub children: #110, #111, #112, #113, #114, #115, #116.           |
|     — |     #116 | TUI Interface for Headless Operations                  | P2. Alt console; defer.                                              |
|     — |     #124 | feat: AD/LDAP authentication support                   | No movement on any strategy metric.                                  |

---

## How to use this doc

- **Phase 1 is done.** Start Phase 2 with **#105 + #106** (audit + soft delete) before any scheduler work, so the metrics light up.
- **Re-rank when STRATEGY.md changes** or when a metric becomes a real bottleneck.
- **Items below the `—` line** in each track are real work, not killed work. Parked until the strategy makes them load-bearing.
- **Add new issues** to the matching track, and link them under their epic (or #166 directly) so the [hierarchy](#epic-hierarchy-super-epic-166) stays complete and no issue sits outside the #166 tree.
