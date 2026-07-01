---
date: 2026-06-30
topic: hash-export-import-search
---

# Hash Export, Pre-Cracked Import & Global Search

## Summary

Deliver a hash-data in/out capability for HashHive, built export-first on a small shared foundation. Export gains user→password output (usable on target), a hashcat/john potfile format, and plaintext-only and uncracked-remainder variants, all round-trip-safe. Pre-cracked import marks matching hashes cracked **system-wide** — filling plaintext and zapping like a real crack — while keeping provenance local and cross-boundary matches invisible to the importer. Search finds any hash, cracked or uncracked, across a project's hash lists.

Corresponds to GitHub issue #102 (P1), which bundles CipherSwarm parity items #625 (export), #635 (pre-cracked import), and #624 (global search).

## Problem Frame

A red team operator runs concurrent cracking campaigns and needs the recovered material to leave the system in a form they can *use on the target* — an account-to-password mapping, not a bare `hash:plain` pair. Many hash sources arrive as `user:hash` (shadow, NTDS/secretsdump), so the account context is the point; export that drops it produces a report artifact, not usable credentials.

Two adjacent gaps compound this. First, an operator who already holds cracked material from another tool or a prior engagement has no way to tell HashHive "these are done" — so the fleet burns GPU-hours re-cracking hashes whose answers are already known, directly against the fleet-utilization and crack-yield-per-GPU-hour metrics. Second, there's no way to ask "have we seen this hash before, cracked or not?" across a project's lists, which is the same knowledge the fleet needs to avoid duplicate work.

Today none of this is fully served: a cracked-results CSV export exists but omits the account and offers no potfile or variants; the parser can ingest `user:hash:plain` on upload but can't mark *existing* rows cracked from an external source; and search over hash items exists only per-list (hash value) or project-scoped over already-cracked rows.

## Key Decisions

- **Export leads; import and search ship too.** Export is the piece an operator feels the absence of this week (it produces usable credentials). Import and search are in scope but sequenced after export.

- **Extend the existing export, don't build new.** The cracked-results CSV export already streams filtered rows and already solves delimiter escaping. Username/source columns, potfile format, and the plaintext-only / uncracked variants layer onto it rather than duplicating it.

- **System-wide plaintext truth, compartmentalized provenance.** A crack (or imported pre-crack) is universally true, so its plaintext fills every matching hash value across the instance. But the *provenance* — who imported it, which source, which other lists matched — does not propagate: only the operator's target list records source/user, and the importer is never told which other lists or projects contained the same hash. This preserves engagement compartmentalization.

- **Propagation zaps like a real crack.** When propagation fills a plaintext on a hash under a live campaign anywhere in the instance, the normal zap fires so agents stop cracking it. The zap is a mechanical skip-signal, not a disclosure, so it serves fleet efficiency without violating the information boundary.

- **"Global" search means project-wide, not cross-project.** Search spans all hash lists within a project. Cross-project discovery is deliberately excluded for operators — the same information boundary that governs import propagation forbids an operator learning that another project holds a given hash.

- **Foundation first: structured hash-item metadata + match-by-value primitive.** `hash_items` gains structured metadata (at minimum `user` and `source`, replacing the loose `metadata.username` jsonb usage), and a match-hashes-by-value-across-the-instance primitive. Both export (source column) and import (propagation, provenance) depend on them, so they're built once, up front.

- **The round-trip format is HashHive's native `username:hash:plaintext`.** Export can emit exactly what import consumes, so cracked state round-trips losslessly between instances and engagements.

## Actors

- A1. **Operator** — exports recovered credentials to use on target, imports pre-cracked material from external tools/potfiles, and searches for a hash across the project.
- A2. **Fleet agents** — consume zaps; stop working a hash once its plaintext becomes known through propagation.
- A3. **Automation / CLI** — scripts the export→import round-trip and search via the Control API surface.

## Requirements

### Foundation

- R1. `hash_items` records carry structured metadata covering at least the associated account (`user`) and the provenance (`source`), superseding the current loose `metadata.username` usage.
- R2. A match-by-hash-value primitive locates every hash item sharing a given hash value across the entire instance (all lists, all projects), for propagation and search to build on.

### Export

- R3. Export emits the associated account so output is user→password, not just hash→password, whenever the account is known for a row.
- R4. Export offers selectable content variants: cracked pairs (with account + source), recovered plaintexts only (a wordlist), and the uncracked remainder.
- R5. Export offers a human/report format (CSV, with account, source, and hash-list/campaign context columns) and a machine-reuse format (hashcat potfile; john potfile as an additional option), with CSV as the primary and potfile as the secondary.
- R6. Every export format round-trips safely when plaintexts contain delimiter characters (`:`, `,`, quotes, newlines): CSV per RFC 4180 quoting; potfile and `user:hash:plaintext` per the hashcat first-colon convention so the consumer reconstructs fields losslessly.
- R7. Potfile export is keyed to the hash list's hash type (its hashcat mode) so the file is directly consumable by hashcat/john.
- R8. Export is available on both the dashboard (interactive) and the Control API (automation).
- R18. The operator chooses export scope — single hash list, campaign, or whole project — as a first-class selection, independent of content variant and format.

### Import

- R9. An operator imports pre-cracked material (`hash:plain`, `user:hash:plain`, and hashcat/john potfile format) and matching existing hash items are marked cracked as if freshly cracked (plaintext + cracked timestamp set).
- R10. Import matches by hash value system-wide: a matched hash value in any other list/project also receives the plaintext.
- R11. Provenance (source, user, and the fact of a cross-boundary match) does not propagate — only the operator's target list records import source/user, and the importing operator is not shown which other lists or projects matched.
- R12. When propagation fills a plaintext on a hash under a live campaign, the zap fires so agents skip the now-known hash.
- R13. Import is available on both the dashboard and the Control API.

### Search

- R14. An operator searches for a hash value across all hash lists in a project and sees which lists contain it and whether each is cracked.
- R15. Search returns both cracked and uncracked matches (so "have we seen this hash before?" is answerable regardless of crack state).
- R16. Search results respect the information boundary: no cross-project results are returned to an operator.
- R17. Search is available on both the dashboard and the Control API.

## Key Flows

- F1. **Export recovered credentials for use on target**
  - **Trigger:** Operator finishes (or partially runs) a campaign and wants usable creds.
  - **Steps:** Operator selects scope (hash list / campaign / project) and a content variant + format; system streams the file with account and source preserved and delimiter-safe encoding.
  - **Outcome:** A file the operator can act on directly (feed to a target, a report, a wordlist, or a follow-up campaign).
  - **Covers R3, R4, R5, R6, R7, R8, R18.**

- F2. **Import pre-cracked material and stop wasted work**
  - **Trigger:** Operator holds cracked pairs from another tool/potfile.
  - **Steps:** Operator imports into a chosen list; the match-by-value primitive finds every instance-wide match; each match gets the plaintext as if cracked; provenance is written only to the target list; live campaigns elsewhere zap the newly-known hashes; the operator sees only their own list's result counts.
  - **Outcome:** Known hashes are marked cracked everywhere, the fleet stops re-cracking them, and no cross-engagement information leaks.
  - **Covers R9, R10, R11, R12, R13.**

- F3. **Search for a previously-seen hash**
  - **Trigger:** Operator wants to know if a specific hash has been seen or cracked in this project.
  - **Steps:** Operator queries a hash value; system returns matches across the project's lists with per-list crack state.
  - **Outcome:** Operator learns whether the hash is already known before spending effort on it.
  - **Covers R14, R15, R16, R17.**

## Acceptance Examples

- AE1. **Covers R6.** Given a recovered plaintext `p@ss:w,ord"1`, when the operator exports CSV and re-opens it (or re-imports it), then the account and plaintext reconstruct byte-for-byte with no field corruption.
- AE2. **Covers R3, R4.** Given a hash list ingested as `user:hash:plain`, when the operator exports cracked pairs, then each row includes the account, and when they instead export the plaintext-only variant, then only plaintexts appear (no accounts, no hashes).
- AE3. **Covers R10, R11.** Given the same NTLM hash exists in list A (project 1) and list B (project 2), when the operator imports its plaintext into list A, then list B's item is also filled with the plaintext, but the operator sees only list A's counts and no indication that list B (or project 2) was affected.
- AE4. **Covers R12.** Given a live campaign is cracking a hash that an import elsewhere just resolved, when propagation fills the plaintext, then the zap fires and agents stop working that hash.
- AE5. **Covers R15, R16.** Given a hash exists uncracked in the operator's project and cracked in a different project, when the operator searches for it, then the uncracked match in their own project is returned and the other project's match is not.

## Scope Boundaries

- Cross-project (instance-wide) search for operators — excluded by the information boundary. Plaintext *truth* propagates cross-project silently; *discoverability* does not.
- Disclosing to the importer which other lists/projects matched — excluded, same boundary.
- ML-driven or analytic use of cracked data — out (STRATEGY defers this).
- A redesign of the zap mechanism — out; propagation reuses the existing zap system from #98.

## Dependencies / Assumptions

- Issue #98 (Hash Item Storage, crack results, zap system) is closed and provides the data model, crack-state semantics (`cracked_at NULL` vs set), and the zap system this builds on.
- The metadata schema expansion (R1) is a prerequisite for the full-value export (source column) and for import provenance; it's the first foundation step.
- Potfile correctness assumes the hash list's hash type is set; the mapping from a list to its hashcat mode already exists (`hash_types.hashcat_mode`). Rows whose hash type is unknown may not be potfile-exportable — handling for that is a planning detail.
- The existing per-`(hash_list_id, hash_value)` uniqueness means the same hash value legitimately appears as separate rows across lists; the match-by-value primitive (R2) operates across those rows.

## Outstanding Questions

**Deferred to planning:**
- Exact structured-metadata field set beyond `user` and `source` (e.g., original source-line, salt) and the migration from `metadata.username`.
- Whether import runs synchronously or as a BullMQ job (the upload/parse pipeline is already async; large potfile imports likely follow suit).
- Whether cross-project propagation is transactional or eventually-consistent, and how it interacts with in-flight task assignment.
- Control API error/envelope shapes for the new endpoints (RFC 9457 per existing Control API convention).

## Sources / Research

- `packages/shared/src/db/schema.ts:427` — `hash_items` model: `hashValue`, `plaintext`, `crackedAt`, campaign/attack/task/agent FKs, `metadata` jsonb; unique index on `(hashListId, hashValue)`; no dedicated user/source/salt columns.
- `packages/backend/src/routes/dashboard/results.ts:253` — existing `GET /api/v1/dashboard/results/export` CSV export (columns: hash_value, plaintext, campaign, attack, hash_list, cracked_at); `escapeCsv` helper already handles delimiters.
- `packages/backend/src/routes/dashboard/results.ts:117` — existing project-scoped search (`?q=`, hashValue OR plaintext, cracked rows only).
- `packages/backend/src/services/resources.ts:563` — per-hash-list item search (`getHashItems`, hashValue ILIKE only).
- `packages/backend/src/queue/workers/hash-list-parser.ts:46` — line parser for `hash`, `hash:plaintext`, `user:hash:plaintext`; username stored in `metadata.username`; first-colon handling for colon-containing plaintexts.
- `packages/shared/src/db/schema.ts:394` — `hash_types` with unique `hashcat_mode`; `hashLists.hashTypeId` FK is the potfile-format key.
- `packages/backend/src/routes/control/hashlists.ts`, `routes/control/resources.ts` — Control API surface; no export/import/search endpoints exist there yet.
</content>
</invoke>
