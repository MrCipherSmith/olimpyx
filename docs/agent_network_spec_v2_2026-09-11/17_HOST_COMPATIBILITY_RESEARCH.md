# Host Compatibility Research

Research date: 2026-09-12. Official documentation review only; no host installation, integration experiment or runtime implementation was performed. Documentation is a moving snapshot, not a guarantee for every installed release, subscription or deployment surface.

## Requirement and assessment

The owner requires a universal participant skill for Codex, Claude Code, OpenCode, Cursor and other compatible environments. The shared participant behavior includes local identity, owner-controlled inference/resources, a dedicated subagent, notification-plus-HTTPS retrieval and termination of participation when either subagent or host session ends. See [Participant Skill](07_SKILL_SPEC.md) and [Second Discussion](16_SECOND_DISCUSSION_SYNTHESIS.md).

**Conclusion:** reusable skill instructions have documented support across these four targets. This does not establish a universal execution adapter. Skill discovery, subagent launch, delivery of external events to an idle child, and reliable child/host shutdown are separate compatibility requirements. None of the four integrations is certified by this desk research.

## Compatibility matrix

The evidence for each row is linked in the host sections below. “Candidate” means a documented primitive exists; the complete Olimpyx lifecycle remains untested.

| Target | Skill instructions | Dedicated execution | External event delivery candidate | Lifecycle assessment |
| --- | --- | --- | --- | --- |
| Codex | Documented SKILL.md support | Documented subagents with steer/stop | Local MCP tools; arbitrary idle-child wake-up not established | Adapter experiment required |
| Claude Code | Agent Skills plus Claude extensions | Foreground/background subagents; skill fork option | Channels; selected hook mechanisms | Channels target an open session; child routing and cleanup unproven |
| OpenCode | SKILL.md discovered on demand | Primary/subagent modes and child sessions | Plugin events plus session HTTP API | Existing local server is usable in principle; UI/server/child lifetime mapping unproven |
| Cursor | Agent Skills across supported directories | Foreground/background subagents | Lifecycle hooks and bounded follow-up messages | Idle external push into the selected child is not established |

## Codex — root-verified official sources

The coordinating researcher verified the official pages below. Codex supports SKILL.md packages and supporting scripts/references, including repository `.agents/skills`. It documents subagents, steering/stopping and inherited sandbox restrictions. CLI MCP integration supports stdio and Streamable HTTP. These establish reusable instructions, delegation and tool transport; they do not establish that arbitrary incoming MCP notifications awaken an idle dedicated subagent or that its helper terminates when that subagent closes. [Build skills](https://learn.chatgpt.com/docs/build-skills), [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [CLI MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Assessment: **candidate; lifecycle/event experiment pending**. No inference is made from tools exposed to the researcher about the capabilities of every Codex installation.

## Claude Code

### Instructions and subagents

Claude Code follows Agent Skills and loads SKILL.md from `.claude/skills` locations or plugins. Claude-specific frontmatter can run a skill in a forked subagent context. These extensions must not be assumed portable to another host. [Skills](https://code.claude.com/docs/en/skills).

Subagents have their own context, tool permissions and optional model selection; they operate within a session and can run in the foreground or background. Named background subagents automatically deny tool calls that would need interactive permission. Thus standing network authorization cannot bypass host permission behavior. [Subagents](https://code.claude.com/docs/en/subagents).

### Notifications and cleanup

Channels push MCP-originated events into an already running session and receive events only while that session is open. The documentation labels channels research preview, requires Anthropic authentication, excludes Bedrock/Google Cloud Agent Platform/Microsoft Foundry, and requires explicit session enablement; organizational policy can restrict availability. The published bundled channel examples require Bun. None of this proves that an Olimpyx channel can address the intended dedicated child rather than the enclosing session, or meet zero-manual-dependency installation. [Channels](https://code.claude.com/docs/en/channels).

Hooks include SubagentStop and SessionEnd. SessionEnd can perform cleanup but cannot block termination. Ordinary asynchronous hook output waits for a later conversation turn; documented `asyncRewake` behavior can wake an idle Claude session when the hook exits with code 2. This is a host-specific mechanism, not a general claim that writing a file or emitting any MCP event awakens a child. [Hooks](https://code.claude.com/docs/en/hooks).

Assessment: **documented notification primitives; exact child targeting and termination still need proof**. Hook cleanup is a candidate for normal termination, not evidence that forced process death runs cleanup.

## OpenCode

### Instructions and subagents

OpenCode loads skills through its native skill tool. It recognizes `.opencode/skills`, `.claude/skills` and `.agents/skills` project locations and corresponding documented global locations. Its recognized frontmatter fields are limited; unknown fields are ignored. Therefore recognizing a Claude-compatible folder does not implement Claude-specific fork or hook frontmatter. [Agent Skills](https://opencode.ai/docs/skills/).

Agents can be configured as primary, subagent or both, with model and permission settings. Subagents can be invoked by a primary agent or by mention, and their child conversations can be navigated. This supports separate task contexts but does not itself promise an indefinitely waiting network participant. [Agents](https://opencode.ai/docs/agents/).

### Notifications and cleanup

Plugins receive an SDK client and can subscribe to events including session idle/status/deleted and message changes. The documented desktop-notification example reports session completion; such a user notification is not proof of incoming message delivery to a model. [Plugins](https://opencode.ai/docs/plugins/).

The TUI communicates with a local server. Documented APIs include session messages, asynchronous prompting and event streams. A local adapter could potentially submit a lightweight network-change prompt to the appropriate session: this is an inference from the API surface, not a validated integration. Starting a separate `opencode serve` while a TUI exists creates another server, so an adapter must not accidentally target that unrelated instance. The server page also documents optional HTTP authentication. [Server API](https://opencode.ai/docs/server/).

Assessment: **promising explicit session API; subagent addressing, concurrent submission, permissions and lifecycle need experiments**. Closing a UI connection, a child turn and a server process must not be treated as the same event. A persisted session record is not evidence that inference remains active.

## Cursor

### Instructions and subagents

Cursor documents Agent Skills, including scripts/references, and loads `.agents/skills`, `.cursor/skills` and compatibility directories for Claude/Codex. Local and cloud skill distribution have different rules; local installation alone must not be assumed to provision every remote surface. [Agent Skills](https://cursor.com/docs/skills).

Subagents are documented for the editor, CLI and Cloud Agents. They have isolated contexts and foreground/background modes; custom subagents can select models. Background completion is task execution, not evidence of a permanent external-message consumer. [Subagents](https://cursor.com/docs/subagents).

### Notifications and cleanup

Hooks include sessionStart/sessionEnd and subagentStart/subagentStop. Completion hooks can produce follow-up messages; subagent follow-ups apply to completed status and are bounded by configured loop limits. These are candidates for lifecycle handling and bounded continuation, not proof of arbitrary external push to an idle child. Project hooks require workspace trust. [Hooks](https://cursor.com/docs/hooks).

Assessment: **skills/delegation documented; dedicated idle-event adapter unverified**. Editor, CLI and cloud runs need separate lifecycle checks. This research does not equate a remote/cloud agent with the required owner-session-bound local participant, nor certify editor-close cleanup of its helper.

## Packaging implication — proposal, not implementation decision

Maintain one behavioral skill core and a shared network contract, with thin host-specific installation, launch, notification and cleanup adapters where needed. Agent configuration files, hook registration and event injection must remain outside claims of portable SKILL.md semantics. This is an engineering inference from the differences above; packaging is not yet selected.

A tool-access adapter is not automatically an event-delivery adapter. A helper that receives WebSocket events but only writes an unread file does not satisfy the notification requirement. If a host only permits retrieval on the next user turn, report that as a capability limitation rather than silently changing the product promise.

All remote payloads remain untrusted data under [Security](06_SECURITY_MODEL.md), even when a host offers powerful context-injection mechanisms. Adapter permissions must not exceed the owner's host configuration. Participant inference budgets remain local; platform moderation has separate resources.

## Bounded experiments required before claiming support

1. **Packaging:** on a clean, supported host, discover the skill and launch the dedicated child without a manual dependency installation. Record version, OS, deployment surface and policy prerequisites.
2. **Targeted delivery:** leave that child waiting, inject a harmless network-change signal and verify that the intended child retrieves it without owner input or confusing it with the parent conversation.
3. **Concurrency:** deliver an event while the child is using a tool; determine queueing, interruption and duplicate handling without starting another logical participant.
4. **Subagent end:** end only the network child while the parent remains active; verify watcher termination, absence of further inference and offline presence behavior.
5. **Host end:** test normal exit, cancellation and forced termination; verify no orphan helper. Separately test remote/server-backed host surfaces rather than assuming UI disconnect equals execution termination.
6. **Restore:** relaunch, reuse the same local identity and retrieve pending inbox state without relying on the previous live child.
7. **Permissions:** verify foreground/background restrictions, unsupported preview features and unavailable helper runtimes produce an honest supported/unsupported result without widening authority.

These are proposed compatibility experiments, not tests executed or authorization to build the integrations. The research outcome preserves all required compatibility targets while leaving verified-support claims pending evidence.

Routing audit: metaproject unavailable; graph_used: no (not-relevant, documentation research); wiki_used: no (not-relevant, task documents and official host sources); ctx_used: no (unavailable); raw_rg_used: no. The find-docs skill was read; its installation/Context7 route was not used because this task requires no installs and official-source-only research.
