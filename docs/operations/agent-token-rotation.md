# Agent Bearer Token Rotation Runbook

## Why this exists

Before S-H2, the agent bearer token was stored plaintext in `agents.auth_token`. A database backup, a SQL-injection read primitive, or any other read path against the agents table surfaced live credentials that grant `/api/v1/agent/*` access. S-H2 introduced a bcrypt-hashed format (`agt_<agentId>_<random>`) and a two-format back-compat window so we can roll out the change without downtime. This runbook is the operator playbook for getting every agent across the cutover.

## What rotation does

A successful rotation:

1. Generates a fresh `agt_<agentId>_<random>` token for the named agent.
2. Persists only the bcrypt hash in `agents.auth_token_hash`.
3. Clears `agents.auth_token` (the legacy plaintext column) atomically in the same UPDATE.
4. Flips `agents.auth_token_format` from `'plaintext'` to `'bcrypt'`.
5. Returns the raw token to the dashboard exactly once with `Cache-Control: no-store`.

The raw token is never written to disk by HashHive. It is the operator's responsibility to deliver the new token to the agent via the existing out-of-band channel (the same one used to provision the agent originally).

## Prerequisites

- HashHive backend running at the schema level produced by migration `0014_salty_tarantula.sql`.
- Dashboard access as a `project admin` for the project that owns the agent. The rotation endpoint is gated by `requireMembershipRole('admin')`; contributors and viewers cannot rotate.
- Out-of-band delivery channel ready (the agent will need the new token to authenticate its next heartbeat).

## Rotating a single agent

The rotation endpoint is:

```http
POST /api/v1/dashboard/agents/:id/rotate-token
```

The response body shape is `{ "token": "agt_<id>_<random>" }`. Treat that string as a secret: write it directly into the agent's configuration (or its secret store), then close the dashboard tab. The dashboard does not display or store the token a second time.

### Suggested operator workflow

1. Stop the agent's hashcat workers (or pause its parent process) so it is not actively heartbeating when you rotate.
2. From the dashboard, navigate to **Agents → [the agent] → Rotate token**.
3. Copy the raw token from the modal into the agent's bearer configuration.
4. Restart the agent and confirm it heartbeats successfully.
5. If the agent fails to authenticate after restart, the operator can re-rotate (the old token is already invalidated; there is no recovery from a lost rotation token without a fresh one).

## Listing un-rotated agents

To find which agents still need to be migrated:

```sql
SELECT id, name, project_id, last_seen_at
FROM agents
WHERE auth_token_format = 'plaintext'
ORDER BY project_id, last_seen_at DESC;
```

Empty result means every agent has been rotated and the DROP-COLUMN follow-up can be scheduled. Until then, treat the `agents.auth_token` column as a live-credential store: restrict who can read it, who can take database backups, and where those backups can live.

## Finishing the migration (DROP COLUMN)

Once the query above returns zero rows AND every project has had time to confirm its agents are stable on the new tokens (suggested minimum: one full sweep of the heartbeat-monitor + operator confirmation), schedule a follow-up release that:

1. Removes the `agents.auth_token` column from the schema.
2. Removes the legacy plaintext code path from `packages/backend/src/middleware/auth.ts` (the `parsed === null` branch in `createAgentTokenMiddleware`).
3. Updates this runbook to "all agents are bcrypt-format; rotation is now the only path".

Do not skip the legacy code-path removal step. Until then, a future schema regression that re-introduces plaintext rows would silently work.

## Failure modes

| Symptom | Likely cause | Resolution |
|---|---|---|
| Rotation endpoint returns 404 | The agent id is not in the operator's active project, or does not exist | Verify the agent's project membership; the `scopedUser` projectId must match the agent's `project_id` |
| Rotation endpoint returns 403 | Caller is not a `project admin` for the agent's project | Ask a project admin to perform the rotation; contributors cannot rotate |
| Agent fails to authenticate after restart | New token was not copied verbatim, or the agent was restarted before persisting it | Re-rotate; the next response is the new live token |
| Multiple agents become "offline" after a rotation pass | The operator may have rotated and forgotten to restart, or pasted the wrong token | Cross-check `agents.auth_token_format = 'bcrypt'` for the affected rows; rotate again if the agent is locked out |

## Security invariants

- The raw token is returned in the response body exactly once. There is no "show me the token again" endpoint by design.
- The `Cache-Control: no-store` header is enforced at the route layer so browser history, intermediate proxies, and disk-backed page caches do not retain a copy.
- The plaintext column is cleared inside the same UPDATE statement that sets the hash. A failed UPDATE leaves the agent with its existing legacy token (no half-rotated state).
- Cross-project rotation is rejected (404). The service function's UPDATE WHERE includes `project_id`; the route guard rejects callers outside the project. Both layers defend the boundary.
