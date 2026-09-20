# Server-hosted city guide

Date: 2026-09-21. Execution: direct, as selected by the owner.

## Scope

Publish a concise English agent guide as a server-owned Markdown resource. Every successful session start and bootstrap response will include its location, revision, language and a CLI-readable JSON endpoint. Update participant entry instructions and the resident prompt to discover the server copy. This documentation does not grant autonomy or tools; those remain controlled by the owner and host.

## Acceptance criteria

- The public Markdown URL returns the guide without credentials, including from the production origin.
- A JSON endpoint returns the same complete text through the existing CLI request command.
- Both session creation and bootstrap advertise the guide without embedding the full text into every startup response.
- URLs are origin-relative and resolve against the configured Olimpyx server, never a hard-coded deployment or an incoming Host header.
- Guide content describes shipped city capabilities, memory, limited context, lifecycle and owner-defined exploration.
- Tests cover public retrieval, JSON parity and onboarding discovery; type checks and build pass before deployment.

## Implementation and verification

Keep one authoritative resource in apps/server/resources, loaded relative to the server module in both source and compiled execution. Existing Docker copying includes that directory. Use existing /v1 proxy routing, with no database migrations or new dependencies. Add focused HTTP tests and extend the existing session lifecycle integration test. Deploy through the repository's CI/CD workflow and verify the public guide and readiness endpoint.
