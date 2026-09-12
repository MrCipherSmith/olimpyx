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

## 9. Centralized shared knowledge

The two-level local/server storage split remains. Server-side information additionally has distinct sharing scopes:
- private operational memory for an agent;
- project knowledge visible to authorized project participants;
- network knowledge intentionally shared with the permitted audience of this server.

Network knowledge supports sharing useful findings, solutions, research materials and selected discussion outcomes. In a private company deployment, network-wide visibility does not mean public internet visibility. Joining a network does not upload the owner's entire local knowledge base or make private memory shared.

Proposals for the interview, not yet selected publication rules:
- separate conversation, hypothesis and reviewed knowledge;
- preserve authorship, sources, dates, revisions and corrections;
- distinguish independent evidence from agents repeating one source;
- define publication authority, dispute handling, removal and retention;
- measure whether other participants actually reuse contributions.

The governance workflow, storage schema and retrieval/publication API remain open.

## 10. Proposed shared knowledge revision and review model

Owner proposal from the voice interview:
- support semantic retrieval over shared knowledge; ClickHouse and PostgreSQL with pgvector are candidates, not a selected stack;
- agents may jointly produce a solution and save it as a knowledge entry;
- another agent may later correct or refine the entry, creating a new revision rather than overwriting the previous content;
- preserve revision history and identify a current revision;
- allow agents to review an entry and record an approval or disapproval with an explanation, informing its assessed usefulness/confidence.

Updated below: proposals require confirmations before promotion. Remaining design details: confirmation threshold and independence; how conflicting revisions are resolved; whether reviews apply to a particular revision; aggregation and independence of reviews; supporting evidence. Retrieval similarity and popularity are not themselves proof of correctness. A more capable model is a reason to consider its proposed correction, not an automatic authority rule.

Retaining history is the normal revision behavior. The existing permanent-deletion question remains open: deletion policy must explicitly address historical revisions and derived summaries.

## 11. Asynchronous confirmation and promotion

Owner clarification: an entry may be stored before receiving reviews. It remains unconfirmed; presence in the database does not require other agents to rely on it. A correction is saved as a proposed revision rather than immediately replacing approved knowledge.

Later agents encountering the knowledge for their own work recheck the proposal and record confirmation or non-confirmation with an explanation. The original authors need not be online and are not required approvers. A proposal immediately becomes the latest/current visible revision, explicitly marked unconfirmed. After multiple agents recheck and confirm it, that revision becomes approved. Latest/current and approval status are distinct: a newer unconfirmed revision may coexist with an older approved revision. All previous revisions remain accessible within the record’s access scope. If no revision has been approved, no approved revision is implied.

Exact confirmation count, reviewer eligibility/independence, competing proposals and treatment of negative evidence remain open. Approval records the network's validation status, not an infallible guarantee of truth.

## 12. Historical evidence and revisable approval

Agents need tools to retrieve a record's revision history, individual versions and their associated available facts, sources and reviews. They may compare older and current content and recheck any revision, including an approved one. Approval is accumulated validation, not a prohibition on challenge or a guarantee of truth.

A correction produces a new visible unconfirmed revision with retained history. The treatment of an existing approval after new disconfirming evidence remains to be specified. Retrieval remains subject to the record's permissions; history access does not grant access to unrelated private data.

## 13. Corporate shared knowledge scopes

For the corporate scenario currently under discussion, shared knowledge has two scopes:
- company-wide knowledge, intentionally shared across participating company agents; possible subjects include projects, roles and discoverable room metadata, with exact contents to be defined;
- private room knowledge, scoped to the participants authorized for that task room.

These sharing scopes do not replace the local identity/server memory split or eliminate private agent memory. A person may run several distinct subagents in different rooms. Knowing company-level metadata does not by itself authorize access to a private room's contents or joining capability.

A room may be created for a single feature or task. Once agents finish and the human user confirms the result, the room may be closed. Retention, historical access and selective transfer of room knowledge to company knowledge after closure are open; closure must not be assumed to mean deletion or automatic publication.

## 14. Selective company publication and retained room archive

The human room owner selects results for publication to company knowledge, such as a summary or the resulting project specification. Full room contents are not automatically published. Selected results retain their own usable content when the room closes.

The latest owner clarification explicitly requires preserving intermediate knowledge, discussion history and work documentation as a room archive, so authorized users can revisit how a feature or other result was produced. This supersedes the earlier spoken suggestion that room knowledge would be erased. Archive permissions, retention duration and reopening behavior remain to be defined; archival access must not imply company-wide publication.
