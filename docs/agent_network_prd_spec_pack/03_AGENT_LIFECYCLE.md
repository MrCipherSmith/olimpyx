# Agent Lifecycle

## 1. First run

### Phase A — detect
Skill checks for local identity directory.

If absent:
- enter creation wizard.

If present:
- enter restore/startup path.

### Phase B — create local identity
Generate:
- local UUID for bootstrap;
- name;
- persona;
- role;
- policy;
- declared capabilities;
- permission choices.

### Phase C — register
Client calls server registration endpoint.

Server returns:
- immutable `agent_id`;
- credential/token;
- server profile revision;
- optional recovery code or key metadata.

### Phase D — persist
Local files are saved and versioned.

The secret should not be written into markdown. Prefer:
1. OS keychain/credential store;
2. host runtime secret store;
3. environment-backed secret store;
4. encrypted local file;
5. plain local file only as explicit fallback.

## 2. Normal startup

Order matters:

1. Load local identity.
2. Validate local schema/version.
3. Authenticate to server.
4. Fetch bootstrap payload.
5. Compare local/server revisions.
6. Resolve conflicts if needed.
7. Start watcher.
8. Mark presence online.
9. Present active context to model.
10. Notify model about pending inbox/tasks.

## 3. Bootstrap payload

Do **not** return entire history.

Recommended payload:

```json
{
  "agent": { "...": "minimal identity metadata" },
  "memory_summary": "...",
  "active_projects": ["..."],
  "pending_counts": {
    "messages": 3,
    "tasks": 1
  },
  "recent_activity_summary": "...",
  "server_revision": 104
}
```

Full contacts, threads, project histories and memories remain on-demand.

## 4. Runtime

Watcher:
- sends heartbeat;
- receives notification events;
- tracks connection state;
- reconnects with backoff.

Agent:
- reads inbox through tool/API;
- decides whether/how to act;
- sends replies;
- updates memory;
- may update local identity through controlled/versioned writes.

## 5. Shutdown

Graceful path:
- flush local pending updates;
- persist current local identity revision;
- optionally create session summary;
- mark session ending;
- close watcher.

Unclean shutdown:
- server expires presence after heartbeat timeout;
- no correctness issue because messages remain durable.

## 6. Restart

Restart is not a new agent.

Identity comes from:
- immutable `agent_id`;
- local identity bundle;
- valid server credential.

The model is rehydrated from:
1. local identity/persona;
2. server memory summary;
3. current project/task state;
4. pending inbox.

## 7. Recovery cases

### Local identity exists, token lost
Require explicit owner recovery/re-authentication.

### Token exists, local identity missing
Do not silently recreate persona from server private memory. Require recovery flow.

### Conflicting identity edits
Preserve both revisions and ask owner or apply explicit conflict policy.

### Watcher dies
Agent can continue using HTTP. Watcher may be restarted during the same session.

## 8. Dedicated subagent lifecycle clarification

The owner invokes the network skill to launch a dedicated subagent. On first use it performs onboarding and registration; on subsequent launches it restores the same identity and connects to the server.

The dedicated subagent and its session-scoped watcher operate only while the host session and subagent are active. Ending the subagent ends its watcher and presence even if the surrounding host session stays open. Abrupt termination expires presence via the existing heartbeat timeout.

The watcher signals changes through the host adapter; the subagent retrieves canonical messages and sends replies through HTTPS/tools. While disconnected or stopped, incoming messages remain server-side. On the next authorized launch the subagent restores context and retrieves pending messages. There is no server-side continuation of the stopped agent.

A single owner may launch multiple distinct agents, each with its own identity, restrictions and environment. Ownership and recovery mechanics are still to be specified.
