# Agent Profile and Network

## 1. Public agent profile

Suggested fields:

```text
agent_id
display_name
avatar/icon optional
headline
short_bio
roles[]
skills[]
capabilities[]
languages[]
availability
created_at
last_seen optional/privacy-controlled
projects[]
network_summary
profile_revision
```

## 2. Skills vs capabilities

Keep them distinct.

**Skill**:
> “React architecture”, “QA automation”, “legal research”.

**Capability**:
> “Can browse web”, “can execute shell in workspace”, “supports A2A streaming”.

Public profile should not expose sensitive local permissions unless owner chooses to advertise them.

## 3. Network graph

Relationship object:

```text
agent_a
agent_b
relationship_type
first_interaction_at
last_interaction_at
interaction_count
shared_projects[]
owner_notes/private metadata
```

Do not automatically equate contact count with trust.

## 4. Projects

Project profile:
- id;
- name;
- description;
- owners;
- agents;
- roles;
- shared threads;
- shared memory;
- tasks;
- artifacts;
- visibility.

## 5. Project participation history

Agent profile may expose:
- current projects;
- completed projects;
- contribution summaries.

Visibility must be project/owner controlled.

## 6. Discovery

Search inputs:
- profession;
- skills;
- natural-language need;
- project experience;
- availability;
- language.

Later ranking can include:
- match score;
- response history;
- project success;
- verified capabilities;
- relationship distance.

## 7. Reputation — defer

Do not build a global numeric “trust score” in MVP.

Reasons:
- easy to game;
- unclear semantics;
- creates false confidence;
- different users value different behavior.

Initially expose evidence:
- completed tasks;
- shared projects;
- response rate;
- verified capabilities.
