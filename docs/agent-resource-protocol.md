# Agent Resource Distribution Protocol

Conformance reference for the Go hashcat agent's handling of static attack
resources (wordlists, rule lists, mask lists). It describes the server-side
contract shipped by issue #108 and the behavior an agent must implement to
skip redundant downloads, decompress correctly, and verify integrity.

This protocol covers **static resources only**. Hash lists are served
separately (per request, filtered to uncracked-only) and are out of scope
here; see [Hash lists](#hash-lists).

## Why this exists

Cracking nodes pull large resources (individual files can exceed 100 GB)
directly from object storage via presigned URLs. Re-shipping the same file to
node after node is the bandwidth cost this protocol removes: an agent that
already holds a resource should not download it again, and a resource that is
worth compressing should travel compressed. The hash_hive server never sees
the resource bytes on download (the agent fetches straight from S3/SeaweedFS),
so cache-skip and integrity verification are **agent-side**.

## The canonical identity: raw-file checksum

Every static resource has a `checksum`: the SHA-256 hex digest of the
**original, uncompressed** file. It is the resource's canonical identity and
serves two roles:

- **Cache key** — the agent decides whether it already holds a resource by
  matching this checksum, not by resource id or URL.
- **Post-download integrity check** — after downloading and decompressing, the
  agent recomputes the SHA-256 of the raw bytes and compares.

Because the checksum is over the raw file, it is stable across changes to the
compression codec or level: the same source file always has the same identity
regardless of how the server chose to store it. Never compute or cache identity
from the compressed bytes.

`checksum` may be `null` when the server has not yet captured it (for a
chunked upload, the checksum is captured by a background worker shortly after
the upload completes). Treat a `null` checksum as "cannot cache-skip or verify
yet" — download and use the file, but do not cache it under an unknown
identity.

## Wire contract

### Resolve a task's resources

```http
GET /api/v1/agent/tasks/{taskId}/resources
Authorization: Bearer <agent token>
```

Returns the static resources the task's attack references:

```json
{
  "resources": [
    {
      "type": "wordlist",
      "id": 42,
      "checksum": "9f86d0818...<sha256 hex>",
      "size": 139921497,
      "encoding": "gzip",
      "downloadUrl": "https://<storage>/...<presigned>"
    }
  ]
}
```

- `type` — `wordlist`, `rulelist`, or `masklist`.
- `id` — the resource id (stable server-side identifier; not the cache key).
- `checksum` — SHA-256 hex of the raw file. Always non-null in a `200` from
  this route — see [Not-ready resources](#resolve-a-tasks-resources) below
  for what happens while it's still `null` server-side.
- `size` — raw (uncompressed) byte length. Same non-null guarantee as
  `checksum`.
- `encoding` — `gzip` or `none` (see [Encoding](#encoding); `null` is a
  hash-list-only value and hash lists are never returned by this route).
- `downloadUrl` — a presigned URL for the stored object.

Only the resources the attack actually references are included; a slot the
attack does not use (e.g. no rule list) is omitted. The response envelope is an
object with a `resources` array so additive fields can be introduced later
without a breaking change.

**Authorization and errors.** The task must be assigned to the requesting agent
and belong to the agent's project. A task that does not exist, is not assigned
to this agent, or is outside its project returns a typed `404` in the agent
error envelope — never a `500`. Do not retry a `404` as if it were transient.

**Not-ready resources.** If the task's attack references a wordlist/rulelist/
masklist that has not finished uploading, **or** whose checksum/compression
pass has not run yet (so its `checksum` or `size` is still unset), the server
does **not** silently omit it, return a partial resource list, or hand back an
unverifiable entry — an agent cracking against an incomplete or unverified set
is a correctness bug, not a minor inconvenience. Instead it returns a typed
`409` with `code: 'TASK_RESOURCES_NOT_READY'` in the agent error envelope,
covering **all** of these causes:

- the resource has no uploaded file at all yet, or
- the resource has landed but the background checksum/compression worker
  has not produced a checksum or size for it yet.

This is **retriable**: back off and re-poll `GET /tasks/{taskId}/resources`
until it returns `200`. The `null`-`checksum`/`size` mention in the
[canonical identity](#the-canonical-identity-raw-file-checksum) section above
describes `GET /resources/{type}/{id}/download-url` — a single-resource
lookup that is not gated by this route's readiness check — not this route's
`200` response, which never contains a null-`checksum`/`size`/`encoding`
static-resource entry.

**Permanently missing resources.** A referenced resource id that does not
exist *at all* in the task's project — hard-deleted, pointing at a different
project, or otherwise misconfigured — is a **different, non-retriable**
condition from the not-ready case above. The server returns a typed `404` (the
same shape as the task-not-found case, never a `409`) rather than looping the
agent through repeated retries that can never succeed. Treat this the same way
as any other `404`: do not retry it as if it were transient.

### Fetch a single resource's metadata

```http
GET /api/v1/agent/resources/{type}/{id}/download-url
```

Returns the same integrity metadata for one resource, alongside the URL:

```json
{
  "url": "https://<storage>/...<presigned>",
  "expiresIn": 21600,
  "checksum": "9f86d0818...",
  "size": 139921497,
  "encoding": "gzip"
}
```

`url` and `expiresIn` are unchanged from before #108; `checksum`, `size`, and
`encoding` are additive and follow the same nullability rules as the resolution
route. The presigned URL is time-limited (`expiresIn` seconds); fetch the bytes
before it expires.

## Encoding

`encoding` tells the agent how the stored object is compressed at rest:

- `gzip` — the downloaded bytes are gzip-compressed; gunzip them to recover the
  raw file, then verify.
- `none` — the downloaded bytes are the raw file; use as-is, then verify.
- `null` — hash lists only; they carry no compression metadata at all (see
  [Hash lists](#hash-lists)). A wordlist/rulelist/masklist always reports
  `gzip` or `none`, never `null` — the column defaults to `'none'` at
  creation and the background worker only ever rewrites it to `gzip` or
  leaves it `none`, so there is no window where it's absent. Contrast with
  `checksum`, which genuinely can be `null` mid-processing on the
  single-resource `download-url` lookup (see the `null`-checksum caution
  above).

Compression uses gzip specifically so a Go agent can decompress with the
standard library (`compress/gzip`) — no third-party codec dependency. The
stored object is **not** served with an HTTP `Content-Encoding: gzip` header
(storage would not auto-decompress it anyway); the `encoding` field is the sole
signal, and the agent decompresses explicitly.

## Agent behavior

### 1. Cache-skip

Maintain a local cache of resources keyed by raw `checksum`. When a task
resolves to a resource:

- If the cache already holds a file whose raw checksum equals the resolved
  `checksum`, **skip the download entirely** and use the held file.
- Otherwise download from `downloadUrl`, then decompress and verify (below),
  then add it to the cache under its checksum.

Skip is by checksum, not by resource id or URL — two resources with identical
content share a cache entry, and a re-uploaded identical file is a cache hit.

### 2. Decompress

After downloading, branch on `encoding`: gunzip when `gzip`, use the bytes
directly when `none`/`null`. A truncated or corrupt gzip stream fails to
decompress; treat that as an acquisition failure (below), not a crash.

### 3. Verify

Compute the SHA-256 of the decompressed (raw) bytes and compare to `checksum`.
On mismatch, the download is corrupt: **do not crack against the file**. Treat
it as a handled acquisition failure — discard the bytes, do not cache them, and
either re-download or report the failure. A `null` checksum means verification
is not possible; use the file for this task but do not cache it under an unknown
identity.

### 4. Cache-entry reuse integrity (agent's decision)

Post-download verification proves the bytes arrived intact. It does **not**
prove a *cached* file is still intact on later reuse — a file on local disk can
degrade (bit-rot, partial overwrite) after it was first verified. The agent
decides its posture and must state it:

- **Re-verify on reuse** — recompute the checksum before reusing a cached file.
  Safest; costs a full local re-hash per reuse.
- **Accept the risk** — trust a once-verified cache entry. Cheaper; a rare local
  corruption could go undetected until the next cache miss.

There is no server-side sweep for at-rest integrity (out of scope, low value in
an air-gapped single-operator deploy), so this is entirely the agent's call.

### 5. Cache eviction and capacity

The cache is bounded local disk against resources that can each exceed 100 GB.
The agent must define an eviction/capacity policy that:

- caps total cache size so a few large resources cannot exhaust the disk, and
- evicts in a way that preserves cache-skip value (e.g. least-recently-used by
  last task use), so it does not evict a resource the agent is about to need
  again.

Both failure modes matter: no cap risks disk exhaustion; over-aggressive
eviction defeats the bandwidth win the cache exists to deliver.

## Hash lists

Hash lists are **not** covered by this protocol. They are small, differ on
nearly every request (served whole, filtered to uncracked-only), and are
fetched separately, out of the static-resource cache-skip flow described
above. Their `download-url` response returns `null` for `checksum`, `size`,
and `encoding`, and they are never included in
`GET /tasks/{taskId}/resources`. `GET /tasks/{taskId}/zaps` — the mid-run
notification of newly-cracked hashes to an agent already holding a hash list —
is a separate, unrelated surface.

### Hash-list freshness (ETag)

A hash list's `download-url` response carries a weak `etag`, distinct from the
raw-content `checksum` used for static resources above:

```json
{
  "url": "https://<storage>/...<presigned>",
  "expiresIn": 21600,
  "checksum": null,
  "size": null,
  "encoding": null,
  "etag": "W/\"hl-42-1735689600000-0\""
}
```

`etag` is derived from the hash list's **last-crack time and cracked count**
— it changes whenever a new hash in the list gets cracked, not on every
request. The cracked count is folded in alongside the last-crack timestamp
(PR #282 review) so that two or more hashes cracking within the same
millisecond still change the etag — the timestamp alone would otherwise stay
put for a request landing in that window, letting an agent reuse a cached set
that's actually missing the later crack(s). An agent that already holds this
hash list's uncracked-only set from a previous fetch sends that etag back as
`If-None-Match`:

```http
GET /api/v1/agent/resources/hash-lists/{id}/download-url
If-None-Match: W/"hl-42-1735689600000-7"
```

- If the etag still matches (no new cracks since), the server returns
  `304 Not Modified` with an empty body and no presigned URL — the agent's
  cached uncracked set is still current and the download is skipped entirely.
- If the etag has changed (or `If-None-Match` was omitted), the server returns
  `200` with a fresh presigned URL and the current `etag` for the agent to
  cache for its next fetch.

`If-None-Match` comparison is **exact-match**: the server compares the header
value to the current etag with plain string equality. Always echo the etag
byte-for-byte, including the `W/"..."` wrapper — there is no comma-separated
etag list support, no `*` wildcard, and no RFC 7232 weak-comparison fallback.

`etag` is `null` for wordlists, rulelists, and masklists — those cache-skip by
`checksum` instead, and `If-None-Match` has no effect for them.

## Conformance summary

An agent conforms when it: resolves a task's resources; skips downloads by raw
checksum match; decompresses per `encoding`; verifies the raw checksum after
download and refuses to crack on mismatch; states and implements a
cache-entry-reuse-integrity posture; and enforces a cache eviction/capacity
policy. The realized bandwidth reduction is observable only once the agent
implements cache-skip against this contract.
