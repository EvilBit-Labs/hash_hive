---
date: 2026-06-08
topic: results-analysis-export-ui
issue: 165
tier: deep-feature
---

# Results Analysis & Export UI + Pattern Analyst Loop + Filter Sharing (Issue #165)

## Summary

Close the Phase 1 crack → review loop on the operator console by shipping the Results surfaces that turn raw cracks into actionable analyst feedback. The backend Results API (`/dashboard/results`, streaming CSV export, attack-mode resolution) shipped in PR #204. This work delivers four frontend surfaces — a global Results page, a Results tab on campaign detail, an All/Cracked/Uncracked view on hash list detail, and a dedicated `/results/patterns` sub-page — plus two new backend endpoints (uncracked hash listing; pattern aggregates) and an intra-lab filter-link sharing affordance.

Scope was expanded during brainstorming beyond the original ticket #165 acceptance criteria: password pattern analysis and result sharing — both originally listed as "out of scope" — were folded in by user direction, with advanced analytics dashboards and role-based plaintext masking remaining out. Because the expansion roughly doubles the ticket's surface area, the work splits into two PRs: **PR1 — Phase 1 close-out** ships only the original AC §§1–6 of issue #165; **PR2 — Patterns + Sharing** ships the dedicated patterns surface, the aggregates endpoint, and the filter-link sharing affordance, tracked under a new follow-up issue created at PR1 merge time. Each PR is independently mergeable; PR2 depends on PR1.

---

## Problem Frame

Today the operator can launch a campaign, watch the campaign run, and watch tasks complete — but cannot easily *see what was cracked*, *who cracked it*, or *what kind of password it was*. The existing `packages/frontend/src/pages/results.tsx` is a 124-line scaffold (search input + 50-row paginated table + a static `<a download>` export link). It is missing every filter on the ticket's AC §1, the Attack column, attribution links, the campaign Results tab, the hash list All/Cracked/Uncracked toggle, the crack-rate statistics cards, and any indication of which kinds of passwords are getting cracked.

That last gap matters more than the others. STRATEGY.md frames the Operator Console track explicitly: *"Analyst work (tuning attacks based on what cracks) lives here — the operator IS the analyst."* The operator looks at what cracked to decide what to try next: which masks to reuse on the sister hash list, which dictionary to mangle harder, which character class to lean on. Without a pattern-analysis surface, the analyst loop happens in someone's head while they squint at a CSV — or it doesn't happen at all and the next attack is a guess.

Six gaps remain to close in PR1 (the original ticket AC):

1. **No filter dropdowns.** Campaign, hash list, and date-range (24h / 7d / 30d / all) selectors are not rendered. Existing `startDate`/`endDate` API support is unused.
2. **No Attack column.** Backend now returns `attackModeName` ("Dictionary" / "Mask" / etc.); the table doesn't render it.
3. **No attribution links.** Campaign and hash-list cells are plain text — operators cannot click through to context.
4. **No campaign Results tab.** `packages/frontend/src/pages/campaign-detail.tsx` has no tab structure; results are not exposed on the campaign surface.
5. **No All/Cracked/Uncracked toggle on hash list.** Uncracked listing is unsupported by the backend today (`/dashboard/results` only returns cracked rows).
6. **CSV export is a static anchor.** Triggers a synchronous browser download with no loading indicator. AC §2 mandates a loading state.

Three additional gaps close in PR2 (the folded-in scope):

7. **No password pattern view.** Operators have no surface that aggregates length distribution, character-class breakdown, mask frequencies, or top-N plaintexts across cracks. The analyst loop runs in someone's head.
8. **No sharing affordance.** Filter combinations are encoded in URL params (or will be after PR1), but there is no surface to copy and send. Operators screenshot or paste raw URLs.
9. **No uncracked listing source.** PR1 ships Uncracked as a third toggle position with a "no backend support yet" empty state; PR2 lands the dedicated `/dashboard/hash-lists/:id/uncracked` endpoint that fills it in.

The work is bounded by what the operator-as-analyst needs to choose the next attack — not by what a security analytics platform would offer. Advanced analytics dashboards (cross-campaign yield trends, fleet-wide pattern reports) and password-strength scoring are explicitly out of identity; they belong to a different product.

---

## Actors

- **A1. Red team operator (results reviewer).** Logged-in HashHive operator, project member, mid-campaign or post-campaign. Wants to see what cracked, click through to context (which campaign, which attack), export filtered results for downstream tooling or reports, and look at the pattern view to decide the next attack. Primary actor for every surface in this work.
- **A2. Red team operator (filter sharer).** Same person as A1, intra-lab collaboration mode. Copies a link to a specific filter combination ("all NTLM cracks from Sprint 1, last 7 days") and sends it to another project member via whatever channel the lab uses. The recipient lands on the right project with the right filters applied.
- **A3. Infrastructure administrator.** Secondary actor from STRATEGY.md. Not a primary user of these surfaces but may glance at the Results page to confirm a recently-fixed agent is contributing cracks. No behavioral requirements differ from A1.

---

## Key Flows

- **F1. Operator opens the global Results page.** Frontend mounts `ResultsPage`. Hook fetches `GET /api/v1/dashboard/results` for the selected project, paginated at 100 rows. Operator applies a campaign filter from a dropdown; URL updates to `/results?campaignId=42`; table refetches. Operator applies date range "last 24h"; URL updates again. Operator searches by hash value; results filter. Operator clicks "Export CSV"; button shows spinner; streaming CSV downloads with filename `results-{project}-{ISO-timestamp}.csv`; spinner clears.
- **F2. Operator clicks attribution links.** From a results row, operator clicks campaign name → routed to `/campaigns/:id`; clicks attack name → tooltip surfaces attack mode + mask/wordlist summary; clicks hash list name → routed to `/hash-lists/:id` which deep-links to the Results tab on that view.
- **F3. Operator opens campaign detail Results tab.** Campaign detail page now has Attacks (default) and Results tabs. Switching to Results renders the same results table scoped to `campaignId={current}`, plus a stats card showing total cracked and crack rate (% of attached hash list size). URL reflects tab state via `?tab=results` so a copied link reopens on the same tab.
- **F4. Operator opens hash list detail Results view.** Hash list detail page exposes an All / Cracked / Uncracked segmented control. "All" shows everything; "Cracked" shows results-API rows scoped to `hashListId`; "Uncracked" shows uncracked hashes via the new dedicated endpoint (PR2). Stats card shows total hashes, cracked count, crack rate. Per-list "Export CSV" mirrors the global export.
- **F5. Operator watches cracks come in live.** During an active campaign, the global Results page table, campaign Results tab table, and hash list Results view all auto-refetch every 30 seconds while the page is visible (`refetchInterval` from TanStack Query). New crack rows appear at the top of the table without manual refresh. Patterns page does NOT auto-refetch — it refetches on tab focus and on explicit user action only.
- **F6. Operator opens the pattern view.** Operator clicks "View patterns" link from the global Results page or navigates to `/results/patterns`. Backend `GET /api/v1/dashboard/results/patterns` returns aggregates over the currently-filtered result set: length distribution histogram (buckets 1–40+), character-class breakdown (lowercase / uppercase / digit / special class counts), mask frequencies (hashcat-syntax masks like `?l?l?l?l?d?d?d?d` with counts and percentages, top 20), top 20 cracked plaintexts with counts. Same filter dropdowns as Results page; URL params carry filter state; pattern surface inherits the project pin.
- **F7. Operator shares a filter link.** Operator on any Results surface clicks "Copy link". Browser clipboard receives a project-pinned URL: `https://{lab-host}/results?projectId=7&campaignId=42&dateRange=7d`. Operator pastes link into the lab's chat channel. Recipient (another project member) clicks; their session restores `projectId=7` from the URL (overriding `selectedProjectId` if different); the Results page mounts with `campaignId=42&dateRange=7d` already applied. Recipient sees the same filtered view.

---

## Requirements

### PR1 — Phase 1 Close-Out (Original Ticket AC)

- **R1. Global Results page renders six columns** — Hash Value, Plaintext, Campaign, Attack, Hash List, Cracked At. Plaintext uses monospace font and shows a hyphen placeholder when null. Long plaintexts wrap (no horizontal scroll). Closes ticket AC §1.
- **R2. Three filter dropdowns plus search.** Campaign (all / specific from `useCampaigns()`), Hash List (all / specific from new `useHashLists()` hook), Date Range (last 24h / 7d / 30d / all → resolved to ISO `startDate`/`endDate` params). Search input filters by hash value or plaintext via `q` param. Filter changes reset offset to 0.
- **R3. Pagination at 100 rows per page.** Replaces current 50-row default. Page indicator shows `{offset+1}–{min(offset+limit, total)} of {total}`. Previous/Next buttons disable at boundaries.
- **R4. URL-param-backed filter state.** Filter and search state lives in `useSearchParams`; a refreshed page restores the same view. Foundation for sharing (R12) and for F2's tab-deep-linking.
- **R5. CSV export with loading state.** "Export CSV" button is a mutation, not a static anchor. While pending: button shows spinner + "Exporting…" text; button is disabled. Resolved blob triggers programmatic anchor click with filename `results-{projectName}-{ISO-timestamp}.csv` (where `projectName` is slugged); object URL is revoked. Closes ticket AC §2.
- **R6. Campaign detail Results tab.** New tab structure on `packages/frontend/src/pages/campaign-detail.tsx` exposes Attacks (default) and Results. Results tab renders the shared results table scoped to `campaignId`, plus a stats card showing total cracked + crack rate (% of attached hash list size). Tab state in URL `?tab=results`. Closes ticket AC §3.
- **R7. Hash list detail Results view with All/Cracked/Uncracked toggle.** Segmented control on `packages/frontend/src/pages/hash-list-detail.tsx`. In PR1: Cracked = results API; All = results API + existing hash-items listing merged client-side OR a TODO marker depending on what the existing hash-items endpoint supports (plan-time decision); Uncracked = empty state with "coming soon" copy. Stats card shows total hashes, cracked count, crack rate. Per-list "Export CSV" button scoped to `hashListId`.
- **R8. Attribution links on every results row.** Campaign cell → `<Link to="/campaigns/$id">`. Hash list cell → `<Link to="/hash-lists/$id?tab=results">`. Attack cell → text with native `title` tooltip carrying `attackModeName` + (where available) mask/wordlist summary. Closes ticket AC §5.
- **R9. Plaintext always visible to authenticated project members.** No masking, no role-based gates. Monospace font. Long plaintexts wrap with `break-all` rather than truncate. Closes ticket AC §6.
- **R10. Wire types from `@hashhive/shared`.** Remove the locally-declared `CrackedResult` / `ResultsResponse` interfaces from `packages/frontend/src/hooks/use-results.ts`; replace with `z.infer` from the existing `crackedResultRowSchema` / `listResultsResponseSchema` in `packages/shared/src/schemas/results.ts`. AGENTS.md compliance.
- **R11. 30-second polling on results tables.** TanStack Query `refetchInterval: 30_000` on the global Results, campaign Results tab, and hash list Results queries while document is visible. Operators see cracks trickle in during active campaigns without manual refresh.

### PR2 — Patterns + Sharing (Folded-In Scope)

- **R12. Filter-link sharing affordance.** "Copy link" button on the global Results page and the patterns page. Serializes current filter state (campaign, hash list, date range, search) into URL search params and prepends the active `projectId`. Recipient who opens the link has their session's `selectedProjectId` overridden by the URL `projectId` for the duration of the page mount (with a confirmation toast: "Viewing project {name}. Click here to switch back to {prev}."). Filter-only links (no project) work but require the recipient to already have the right project selected.
- **R13. Dedicated `/results/patterns` sub-page.** New route. Inherits the same filter dropdowns as the global Results page. Renders four cards: length-distribution histogram, character-class breakdown bars, mask-frequency table (top 20), top-N plaintexts table (top 20). Filter changes refetch aggregates. Page does NOT auto-poll; refetches on tab focus and on a "Refresh" button click. "Copy link" affordance per R12.
- **R14. New backend endpoint: pattern aggregates.** `GET /api/v1/dashboard/results/patterns` accepts the same filter params as `/dashboard/results` (campaign, hash list, date range, search). Returns aggregates computed server-side over all matching cracked rows in the project. Response carries length-histogram buckets, char-class counts, top-20 masks with counts/percentages, top-20 plaintexts with counts. Cookie-authenticated, project-scoped via session (ignores client-supplied `projectId` header). Wire shapes in `@hashhive/shared` as Zod schemas; route registered with `@hono/zod-openapi`.
- **R15. New backend endpoint: uncracked hash listing.** `GET /api/v1/dashboard/hash-lists/:id/uncracked` returns hashes in the given hash list where `plaintext IS NULL`. Pagination at 100 rows. Project-scoped (the hash list's project must match session project). Cookie-authenticated. Returns Hash Value column only (no attribution to resolve — uncracked rows have no campaign/attack). Wire shapes in `@hashhive/shared`; route registered with `@hono/zod-openapi`.
- **R16. Hash list Uncracked toggle wired to new endpoint.** Replaces the PR1 "coming soon" placeholder with real data. Stats card's "crack rate" computation moves from a derived heuristic to `(cracked count) / (cracked count + uncracked count)`. The All toggle position now merges Cracked + Uncracked client-side (PR2 plan-time decision: either merge in-component or add a third endpoint variant; brainstorm bias is client-side merge to avoid a third surface).

---

## Acceptance Examples

- **AE1 (R1, R2).** Operator opens `/results` with no filter. Sees up to 100 rows. Picks "Last 24h" from date range. URL becomes `/results?dateRange=24h`. Within a second, table refetches. Row count drops to whatever cracked in the last 24 hours.
- **AE2 (R5).** Operator clicks "Export CSV" with a filter active. Button replaces "Export CSV" with a spinner + "Exporting…". Button is disabled. Browser begins downloading `results-acme-corp-2026-06-08T14-23-11.csv`. On completion, button returns to "Export CSV"; download includes EVERY filtered row, not just the first 100.
- **AE3 (R6).** Operator on `/campaigns/42` sees Attacks tab active. Clicks Results tab. URL becomes `/campaigns/42?tab=results`. Stats card shows "Cracked: 1,283 / 5,000 (25.7%)". Table below shows the campaign's cracks. Clicking hash list cell on a row navigates to `/hash-lists/9?tab=results`.
- **AE4 (R7, PR1).** Operator on `/hash-lists/9` clicks the Uncracked toggle. Surface shows an empty state with copy "Uncracked listing is coming in the next release. For now, see the Cracked tab." Stats card still shows total hashes + cracked count (the cracked-count source is the results API).
- **AE5 (R7, R16, PR2).** After PR2, same operator clicks Uncracked toggle. Table renders 100 uncracked hash values. Pagination works. Crack rate stat is exact, not derived.
- **AE6 (R8).** Operator on `/results` row sees campaign "Sprint One" as a hyperlink. Clicks. Lands on `/campaigns/100`. Browser back button returns to `/results` with all filters preserved.
- **AE7 (R11).** Operator opens `/results` mid-campaign. Tab is visible. After 30s, a new crack row appears at the top of the table without the operator clicking anything. Operator switches tabs in the browser; page does not refetch in the background.
- **AE8 (R12).** Operator on `/results?campaignId=42&dateRange=7d` clicks "Copy link". Clipboard receives `https://hashhive.lab.local/results?projectId=7&campaignId=42&dateRange=7d`. Pastes into team chat. Teammate (who has access to project 7 but currently has project 3 selected) clicks. Lands on `/results?projectId=7&campaignId=42&dateRange=7d`. Toast appears: "Viewing project Acme Corp. Click here to switch back to InternalRecon." Filters are applied. Table shows the same view.
- **AE9 (R13, R14).** Operator on `/results/patterns?campaignId=42` sees four cards. Length histogram: bar chart with "8-char: 412 cracks (32%)". Char-class breakdown: bars showing 87% lowercase, 64% digit, 12% upper, 3% special (percentages can exceed 100% summed because a single plaintext belongs to multiple classes). Mask frequency table top row: `?l?l?l?l?l?l?l?l` × 281 (22%). Top-N plaintexts: "password123" × 47 / "summer2025" × 31 / etc.
- **AE10 (R13).** Operator on patterns page sees a "Refresh" button next to "Copy link". Page does not auto-update during a 5-minute view; refresh button refetches on click. Operator switches browser tabs and returns; aggregates refetch on tab focus.

---

## Scope Boundaries

### Deferred for later (in scope for HashHive long-term)

- **In-place result triage** — comments, @-mentions, or "mark as reviewed" flags on individual results. Confirmed during brainstorm as follow-up after PR2; needs new persistence (results-comments table) and notification surface. New ticket at PR2 merge time.
- **Pattern hand-off to campaign wizard** — "Apply as next attack" affordance on patterns page that pre-fills a campaign wizard step with an observed mask or dictionary supplement. Closes the analyst loop end-to-end. Confirmed as follow-up; touches campaign-wizard, may need new wire shapes. New ticket at PR2 merge time.
- **WebSocket-driven live updates** — replaces the 30s polling fallback (R11) once Step 3 (WebSocket Infrastructure) ships. Polling code structured so the WebSocket variant can drop in by replacing the `refetchInterval` with event-driven invalidation.
- **Composite index `(cracked_at DESC, id DESC) WHERE cracked_at IS NOT NULL`** — carried forward from PR #204 review. Streaming export correctness is unaffected; the keyset scan reverts to a sort once the existing single-column index runs out. Schema changes have a separate deploy cadence.
- **Per-user export concurrency cap** — carried forward from PR #204 review. Connection-pool starvation risk under N parallel exports is tractable; will land with issue #163's API key rate-limiter middleware.
- **Mask-frequency over server-side aggregates beyond top-20** — PR2's `/dashboard/results/patterns` returns top-20 masks. Full distribution (every mask with cracks ≥ 2) is a follow-up if operators need it.

### Outside this product's identity

- **Advanced analytics dashboards** — cross-campaign yield trends, fleet-wide pattern reports, time-series of crack-rate-by-mask. Confirmed out of scope. The product is a campaign orchestrator with an analyst feedback loop, not a security analytics platform.
- **Password-strength scoring / "this hash list is weak"** — quantitative judgment on hash list quality. Out of identity; HashHive cracks passwords, it doesn't grade them.
- **Public SaaS sharing surfaces** — signed external links, non-member access, customer-facing shareable reports. STRATEGY.md is explicit: private-lab only, never public SaaS.
- **Role-based plaintext masking** — explicitly disallowed by original ticket AC §6 and by user direction during brainstorm. All authenticated project members see all plaintexts in monospace.
- **In-table inline editing of cracks** — operators don't edit cracks; they look at them.

### Deferred to Follow-Up Work (sequencing within this plan)

- **PR2 itself.** Patterns, sharing, and the uncracked endpoint ship as a follow-up PR after PR1 (Phase 1 close-out) merges. PR2 depends on PR1's filter-state URL machinery (R4) and shared `ResultsTable` extraction (D2). Tracked as a new GitHub issue created at PR1 merge time.
- **Backend `?cracked=false` on `/dashboard/results`.** Alternative path considered and rejected for PR2 (decision D5). If a future surface needs uncracked rows scoped to project (not hash list), the option re-opens.

---

## Key Decisions

- **D1. Split into PR1 (Phase 1 close-out) + PR2 (patterns + sharing).** PR1 ships only the original ticket #165 AC; PR2 ships the folded-in scope. Two PRs are individually reviewable and individually deployable. The Phase 1 sequence stays clean; PR2 gets to breathe instead of bundling under a "close-out" framing. Cost: a follow-up issue and a slight duplication of test scaffolding between PRs. Confirmed during synthesis.
- **D2. Extract a shared `ResultsTable` component.** All three results surfaces (global Results, campaign Results tab, hash list Cracked view) render the same table with different filter pins. One reusable component, three call sites. Lives at `packages/frontend/src/components/features/results/results-table.tsx`. Lands in PR1.
- **D3. New `<Tabs>` compound component in `components/ui/`.** None exists yet. Required for the campaign Results tab (R6). URL-param-driven (`?tab=`). Tiny three-piece API: `Tabs.List` / `Tabs.Trigger` / `Tabs.Content`. Lands in PR1. Reusable elsewhere as the dashboard grows.
- **D4. New `<SegmentedControl>` compound component in `components/ui/`.** For the hash list All/Cracked/Uncracked toggle (R7). Distinct from Tabs because the visual treatment is different (toggle-group vs tab-strip) and the state shape is single-select within a small fixed set. Lands in PR1.
- **D5. New dedicated `/dashboard/hash-lists/:id/uncracked` endpoint** (R15). Rather than extending `/dashboard/results` with `?cracked=false`. Rejected alternatives: extending results API (mixes cracked and uncracked envelopes), reusing existing hash-items listing (would need a `?status=` filter and the shape mismatches what the hash list view wants). New endpoint cleanly separates the "list cracks" surface (project-scoped, attribution-resolved) from the "what's left in this hash list" surface (hash-list-scoped, attribution-irrelevant). Confirmed during brainstorm. Lands in PR2.
- **D6. New dedicated `/dashboard/results/patterns` aggregates endpoint** (R14). Rather than client-side aggregation over the streaming export. Server-side aggregates avoid pulling N MB of plaintext over the wire to render a histogram; the right primitive for future use; testable in isolation. Lands in PR2. Plan-time follow-up: indexing strategy for char-class queries.
- **D7. 30s polling on results tables; patterns surface refetches on focus/manual** (R11, R13). Polling is the WebSocket-replacement pattern HashHive already uses for stats (see `use-dashboard.ts`). Pattern aggregates are computationally heavier; auto-polling them is wasteful and the operator opens patterns to think, not to watch. Confirmed during brainstorm.
- **D8. Project-pinned filter links** (R12). The `projectId` is included in the copied URL so a recipient with multiple project access lands on the right project. Recipient gets a toast confirming the project switch and a one-click return to their previous project. Filter-only (project-omitted) links work but require manual project selection. Confirmed during synthesis.
- **D9. Pattern surface inherits Results page filter dropdowns.** Same campaign / hash list / date range / search controls. Operator drills into a filtered Results view, clicks "View patterns", lands on the patterns surface with the same filters applied. Less surface to teach, fewer mental models to maintain.

---

## Dependencies / Assumptions

- **PR #204 (Results API & CSV Export) is merged.** Confirmed: merged to main as commit `83e0d4e`. Backend `/dashboard/results` and `/dashboard/results/export` are live; `@hashhive/shared` exports `crackedResultRowSchema`, `listResultsResponseSchema`, `HASHCAT_ATTACK_MODE_NAMES`, `resolveAttackModeName`.
- **`useCampaigns()` hook exists and returns project-scoped campaign list.** Verified in `packages/frontend/src/hooks/use-campaigns.ts`.
- **No `useHashLists()` hook exists yet.** Will be added in PR1 as a thin wrapper over an existing or to-be-added hash-lists listing endpoint. Plan-time check whether the backend already exposes a project-scoped hash lists listing; if not, a new endpoint is in PR1's scope.
- **Hash list detail page (`hash-list-detail.tsx`) currently renders hash items inline.** PR1 wraps the existing view in the segmented control and adds the Results sub-view alongside the existing hash-items view.
- **Campaign detail page (`campaign-detail.tsx`) currently renders attacks inline.** PR1 wraps the existing content in the Attacks tab and adds the Results tab alongside.
- **Filter-link recipient has project access.** A recipient who clicks a link to a project they don't belong to gets a 403 from the backend on the underlying API call; the frontend shows the standard "you don't have access to this project" empty state. No special handling for unauthorized recipients beyond the existing membership check.
- **30s polling is acceptable network load at expected operator count.** Lab operators are 1-5 concurrent users; 30s polling × 4 queries per operator × 5 operators = 40 req/min worst case. Negligible.
- **Pattern aggregation cost is acceptable at expected result-set size.** Largest expected cracked result set per project is ~1M rows. Server-side aggregates over 1M rows with appropriate indexes complete in < 2s. Plan-time confirmation needed.
- **Hashcat mask syntax is stable** (`?l`, `?u`, `?d`, `?s`, `?a`, `?h`, `?H`, `?b`). The pattern-derivation logic encodes these as fixed character-class regexes. New hashcat charset additions would need a code update; acceptable risk.

---

## Success Criteria

- **PR1 lands all six original ticket AC** (§§1–6 of issue #165) verified by acceptance examples AE1–AE7. `just check` and `just ci-check` green.
- **PR2 lands the folded-in scope** (R12–R16) verified by AE5, AE8, AE9, AE10. New backend endpoints have integration tests for project-scoping correctness, auth, and filter behavior.
- **No file exceeds 800 LoC**; per project coding-style. Shared `ResultsTable` keeps each results surface under 400 LoC.
- **All cross-API-boundary types live in `@hashhive/shared`.** Verified by grep: no `interface CrackedResult` or `interface CrackedResultRow` outside `packages/shared/src/schemas/`. AGENTS.md compliance.
- **Accessibility**: filter dropdowns reachable via Tab, segmented control has `role="tablist"`, results tables are semantic `<table>` with `<Th>` scope headers, "Copy link" affordance has a clear ARIA label.
- **STRATEGY alignment**: the analyst loop has a real surface (patterns page) and the operator can act on what they see (filter-link sharing for handoff; future "Apply as next attack" follow-up issue tracked).

---

## Open Questions (Defer to `/ce-plan`)

- **Q1.** Server-side mask derivation: does the backend compute hashcat-syntax masks from plaintexts in SQL (regex / character-class CASE), or pull plaintext into Node and derive there? Performance vs simplicity. Plan-time benchmark.
- **Q2.** Does a project-scoped hash-lists listing endpoint exist? If yes, `useHashLists()` wraps it. If no, PR1 includes a small new endpoint.
- **Q3.** Indexing strategy for pattern aggregates. Likely `(project_id, cracked_at) WHERE plaintext IS NOT NULL` for hot-path coverage. Plan-time decision; PR2.
- **Q4.** Attack tooltip content beyond `attackModeName`: does the backend currently return mask string / wordlist name on the results envelope? If not, tooltip falls back to mode name only in PR1; a follow-up enriches the wire shape.
- **Q5.** "All" position on hash list segmented control (R16): client-side merge of Cracked + Uncracked, or a third backend endpoint variant? Brainstorm bias is client-side merge; final call at plan time.
- **Q6.** Toast UI for the project-switch confirmation (R12, AE8). Does HashHive have a toast pattern already? Plan-time check; new lightweight component if needed.
