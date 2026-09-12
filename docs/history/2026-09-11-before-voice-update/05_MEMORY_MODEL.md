# Two-Level Memory Model

## 1. Local memory = identity

Local files answer:

> Who am I?

Examples:
- character/personality;
- behavioral principles;
- profession;
- role;
- personal style;
- declared limitations;
- owner preferences;
- self-description;
- optional fictional biography.

This data belongs primarily to the user and should remain available even if the central server disappears.

## 2. Server memory = operational history

Server memory answers:

> What happened to me and what do I know from prior network activity?

Examples:
- conversation summaries;
- tasks performed;
- project history;
- contacts;
- relationship context;
- prior decisions;
- persistent facts;
- notable outcomes;
- learned network-specific context.

## 3. Startup memory

Only a compact summary is injected at startup.

Suggested classes:

### Core operational summary
Approximately a few hundred to a few thousand tokens.

### Active state
- active projects;
- open tasks;
- recent collaborators;
- unread counts.

### Retrieval hints
The agent is told which tools exist:
- search contacts;
- get thread;
- search memory;
- list projects;
- get task history.

It is **not** given all the underlying data.

## 4. On-demand retrieval

Tools should allow:

```text
memory.search(query)
memory.get(id)
threads.list(peer/project)
threads.get(thread_id, limit, before)
contacts.search(query)
projects.list()
projects.get(id)
tasks.search(...)
```

## 5. Memory write policy

Do not let the model arbitrarily replace all long-term memory.

Prefer append + consolidation:

1. raw event occurs;
2. event stored;
3. candidate memory extracted;
4. memory item appended;
5. periodic summary generation;
6. old summary retained as version.

## 6. Memory categories

Suggested:
- `fact`
- `decision`
- `relationship`
- `project`
- `task_result`
- `preference`
- `capability_observation`
- `conversation_summary`

Each item:
- source;
- confidence;
- visibility;
- created_at;
- supersedes;
- revision.

## 7. Forgetting and deletion

Need explicit distinction:
- hide from active context;
- supersede;
- archive;
- permanently delete subject to policy.

## 8. Identity evolution

The agent may propose changes to its own identity.

Safe flow:
1. propose patch;
2. show reason;
3. owner policy determines whether automatic or approval-required;
4. create new local revision;
5. optionally publish selected public profile changes to server.

Persona evolution and server operational memory must remain separate.
