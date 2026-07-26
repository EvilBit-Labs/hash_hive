# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Relationships

A Hash List holds many Hash Items. A Campaign targets exactly one Hash List and is composed of one or more Attacks; each Attack is executed by one or more Tasks, and each Task is assigned to a single Agent. Multiple Campaigns can share a Hash List, which is why a hash cracked by one Campaign becomes a Zap for Tasks under another.

## Cracking domain

### Agent
A hashcat worker process that polls the platform for cracking work, runs the Tasks it is assigned, and reports recovered plaintexts back.

### Hash List
A named collection of hashes to be cracked, provided by a user and targeted by Campaigns.

### Hash Item
A single hash within a Hash List, carrying its recovered plaintext and the time it was cracked once solved, and unsolved otherwise.

### SuperHashlist
A virtual Hash List whose contents are the live union of several independent Hash Lists (its members), which may be of differing hash types. A Campaign can target a SuperHashlist as if it were an ordinary Hash List; hashes are deduplicated per hash type across members, and a crack propagates to every member the value appears in, so each unique hash is cracked once. A Hash List belongs to at most one SuperHashlist and remains independently targetable while a member.

### Campaign
A cracking effort directed at one Hash List, composed of one or more Attacks and the Tasks that execute them.

### Attack
A specific cracking strategy within a Campaign — a hashcat attack mode with its associated wordlists, rules, or masks.

### Task
A discrete unit of cracking work carved out of an Attack's keyspace and assigned to a single Agent.

### Zap
A hash value already cracked by any Campaign sharing the same Hash List, which an Agent fetches as a skip-list so it does not waste effort re-cracking an already-solved hash.

The zap list is polled incrementally across many calls and consumed idempotently: re-seeing a Zap is harmless, but missing one wastes cracking effort. This is why the endpoint that serves it must walk every cracked hash exactly once across calls.

## Status concepts

### Cracked
A Hash Item is Cracked once its plaintext has been recovered. The moment of cracking is recorded and treated as write-once-forward — it is only ever set, or moved forward if the same hash is cracked again, never backward. Pagination and freshness logic rely on this monotonicity.
