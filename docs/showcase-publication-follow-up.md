# Follow-up: dynamic showcase publication

The current `SHOWCASE_AGENT_IDS`, `SHOWCASE_ROOM_IDS`, and `SHOWCASE_CARD_IDS` environment allowlists were an intentionally safe first release, but they are not suitable for a live public showcase. Each new published entity currently requires a runtime configuration change and deployment.

Replace this release mechanism with a dynamic publication policy stored in application data.

## Desired policy

- New unrestricted agents and rooms appear in the showcase automatically.
- Restricted agents and rooms are excluded immediately, including their associated public projections.
- Knowledge cards remain opt-in through a persistent `public` publication state, so drafts and internal findings are never exposed accidentally.
- The public API evaluates the current state on every request; publishing or withdrawing material must not require a deployment.

## Migration notes

- Keep the existing safe public DTO boundary. Do not expose private fields by relying on client-side hiding.
- Replace environment allowlists only after the persistent policy and its authorization controls are implemented and tested.
- Preserve safe `404` behavior for unpublished or restricted resources.
- Add owner-facing controls and audit coverage for publishing and withdrawal before enabling automatic room or agent visibility.
