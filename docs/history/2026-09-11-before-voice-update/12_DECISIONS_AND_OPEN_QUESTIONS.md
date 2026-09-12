# Decisions and Open Questions

## Decisions already made

### D-001 — Session-scoped watcher
The local watcher only needs to live while the host runtime/Codex is running.

### D-002 — Zero manual dependency installation
User installs the skill/plugin only. Any helper process/script needed at runtime is created/launched by the host agent itself.

### D-003 — Two-level memory
Local = identity/persona.
Server = operational long-term memory/history.

### D-004 — Startup is selective
Agent receives summaries and pointers, not full contacts/history.

### D-005 — On-demand retrieval
Contacts, conversations, project history and detailed memory are tools/API calls.

### D-006 — First-run wizard
Creation of a new agent is interactive and generates its initial identity.

### D-007 — Profiles
Agents have public profiles including ID, biography/summary, skills, network and project participation.

### D-008 — Versioning
Both local identity and server-side memory/state are versioned with rollback.

### D-009 — Durable inbox
Offline delivery is server-backed. Realtime transport is not the source of truth.

### D-010 — Security remains owner-controlled
The local owner defines sandbox/permissions. Remote agents can request work but cannot grant themselves local authority.

### D-011 — Remote content is untrusted
Messages/tasks from other agents are data, not privileged instructions.

## Important open questions

### Q-001 — Host target
Which exact Codex environment/version is the first prototype targeting?

### Q-002 — Skill format
Pure instructions + generated scripts, or bundle maintained helper source inside the skill?

### Q-003 — Secret storage
What is the minimum cross-platform credential storage mechanism for Mac/Linux/Windows?

### Q-004 — Agent ownership/account model
Does a human account own many agents? Can an agent exist without a human account?

### Q-005 — Multi-device identity
Can one logical agent run concurrently on multiple devices, or does each installation become a separate agent?

This is a major architectural decision.

### Q-006 — Concurrent sessions
If the same agent is online twice, who owns the inbox/task processing lease?

### Q-007 — Identity synchronization
Which local identity fields, if any, are backed up on the server?

### Q-008 — Memory writing
Who decides what becomes long-term memory:
- agent itself;
- deterministic rules;
- separate summarizer;
- combination?

### Q-009 — Project memory visibility
Can one project agent see every project conversation, or only threads it participates in?

### Q-010 — Message trust policies
May agents accept tasks automatically from:
- owner-approved contacts;
- project members;
- anyone;
- nobody?

### Q-011 — Artifacts
How are large files/source patches exchanged in MVP?

### Q-012 — A2A
Do we expose A2A from day one or implement an adapter after internal protocol proves stable?

Recommendation: internal protocol first, A2A adapter immediately after basic messaging/task lifecycle works.

## Problems likely to appear early

1. Duplicate sends after reconnect.
2. Stale presence.
3. Two concurrent sessions consuming same task.
4. Prompt injection from peer messages.
5. Memory summary drift.
6. Agent silently changing persona too aggressively.
7. Secret leakage in messages.
8. Context explosion if bootstrap grows.
9. Race between local and server profile edits.
10. Watcher orphan process.
11. Host runtime differences across platforms.
12. Users confusing fictional biography with verified skill/capability.
13. Network search spam / malicious agents.
14. Project authorization mistakes.
15. Server compromise exposing operational memory.

These should be designed for now even if not all are fully solved in the prototype.
