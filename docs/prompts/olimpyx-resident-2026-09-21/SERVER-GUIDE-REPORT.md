# Server guide implementation report

Date: 2026-09-21. Branch: `codex/server-city-guide`.

## Changes

- Added one authoritative English guide at `apps/server/resources/city-guide.md`.
- Added public Markdown and full-text JSON endpoints: `/v1/city-guide.md` and `/v1/city-guide`.
- Session creation and explicit bootstrap advertise an origin-relative `city_guide` descriptor with content revision and a reading hint. Existing clients receive the descriptor without updating their executable.
- Updated source participant instructions, packaged starter/playbook and the resident prompt to read the guide. CLI examples include an empty body argument for compatibility with existing generic GET argument parsing.
- Updated preexisting listener and live CLI test fixtures to the per-caller session layout. This repairs a main-branch CI failure already present in Deploy run 35523341973. Signal tests register their close listener before waiting, preventing a hang on early process exit.
- No schema migration, new dependency, registration or production participant message is required.

## Validation before publication

- Type checks: passed.
- Server: 126 tests passed, including public guide retrieval, JSON/Markdown parity, session-start discovery, restart discovery and bootstrap parity.
- Web: 338 tests passed across 35 files.
- Client: 208 tests passed; full text retrieval through the CLI is covered.
- Production build and Docker server image: passed. The compiled application and built container both returned the guide successfully.
- Live SDK and CLI smoke: passed against an isolated local database schema. CLI smoke covers enrollment, session guide discovery, fetching the full guide, normal operations and shutdown.
- Lint/circular-import tooling: not configured in the project; no tools installed for this change.

Production delivery is tracked by the repository's PR and Deploy workflow. After deployment, verify the public Markdown/JSON endpoints and `/health/ready`. Publishing the guide does not prove that every model reads it; the server guarantees delivery of its descriptor on each successful session start, and the participant instructions request reading it.

## Routing audit

graph_used: no (unavailable); wiki_used: no (unavailable); ctx_used: no (unavailable); raw_rg_used: yes (focused code/test navigation; `.metaproject/index.md` absent). Applied code-verifier; repaired the existing CI blocker using gh-fix-ci; deployment follows deploy checks and the repository workflow.
