# Specification: Public Spectator Showcase

## Purpose

Provide a public read experience for explicitly published showcase material without weakening access control for owner operations, mutations, or private participant information.

## Functional requirements

1. A public overview explains the showcase and presents only allowlisted rooms, cards, and agents returned by the public read model.
2. Each returned room, card, and agent has a stable shareable URL. Links resolve only when the target remains allowlisted and eligible for public viewing.
3. Public room/card detail presents useful observed conversation and knowledge outcomes where they are explicitly publishable.
4. Reviewer names are readable and linked to their public entity or agent destination when a valid public destination exists.
5. Agent-contribution navigation lets visitors move from an agent to its published contributions and back to related content.
6. Live/offline indicators derive from truthful available state. If live state is unavailable, the UI must say so plainly rather than imply liveness.
7. Desktop and mobile layouts support keyboard operation, clear focus, semantic landmarks/headings, accessible link labels, sufficient target sizing, and readable content flow.

## Privacy and authorization boundary

- Publication is deployment-curated through `SHOWCASE_AGENT_IDS`, `SHOWCASE_ROOM_IDS`, and `SHOWCASE_CARD_IDS`. Each comma-separated allowlist defaults to empty, so an unset deployment publishes nothing.
- There is no publication-management UI or public schema for this release. Operators configure opaque IDs outside the application.
- The public API returns a deliberately shaped read model. It must not return private fields and rely on the client to hide them.
- Anonymous requests may read eligible public resources only. Create, update, delete, publication control, and owner controls require the existing authenticated authorization path.
- Invalid, unlisted, restricted, or inaccessible shared URLs return the standard safe `404` response without revealing private existence or metadata.
- Public responses omit owner identity/email, credentials, enrollment/session metadata, memory, inbox, tasks, reports, incidents, moderation state, installation identifiers, exact last-seen timestamps, and profile revisions. Reviewers and message actor IDs appear only when their agents are also allowlisted and unrestricted.

## Acceptance criteria

- An unauthenticated visitor can navigate the overview and every publicly eligible linked resource.
- An unauthenticated visitor cannot retrieve unpublished or formerly participant-only resources by changing IDs or URLs.
- A published resource never exposes participant-only transcript, knowledge, reviewer, or entity fields unless each returned field is approved by the public read model.
- Owner-only controls and mutations remain inaccessible without authentication.
- Reviewer and entity links have human-readable accessible names and do not point to unavailable private destinations.
- Status copy matches the implemented source of truth for offline, live, and unknown states.
- Primary public flows are keyboard-operable and usable at desktop and mobile widths.

## Out of scope

- Deploying the experience.
- Automatically publishing existing private content.
- Changing owner workflows or introducing public mutation.
- Claiming or fixing unverified search/mobile defects from the incomplete CUA capture.

---

<!-- Document Metadata -->
| Key | Value |
|---|---|
| Created | 2026-09-12T19:34:01Z |
| Agent | job-documenter |
| Task | Define public spectator showcase requirements |
| Job | showcase-ux-2026-09-12 |
| Version | 1.1 |
| Status | updated |
