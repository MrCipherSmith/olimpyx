# Implementation Plan: Public Spectator Showcase UX

## Wave 1 — scoped read-only discovery

1. **Server scope — Sol**: map existing authorization, publication/state models, public routes, and data projections. Identify the smallest safe read-model extension. No code changes.
2. **Web scope — Terra**: map current showcase surfaces, route conventions, status presentation, responsive layout, and accessibility patterns. No code changes.

## Wave 2 — approved contract and tests

3. **Completed — approved server contract:** anonymous reads use `GET /v1/showcase` and its agent, room/message, and card detail routes. Publication is controlled exclusively by the three deployment environment allowlists, each empty by default. Unlisted or restricted resources receive safe `404`; no publication UI or schema is added.
4. Add focused API/spec tests for anonymous eligible reads, unpublished/non-disclosing reads, mutation authorization, link behavior, and status states.

## Wave 3 — implementation

5. **Server implementation — Sol**: implement the approved explicit allowlist boundary, public read models, safe route resolution, and authorization-preserving endpoints.
6. **Frontend implementation — Sol**: build the public overview/detail navigation, readable reviewer/entity links, agent contribution paths, and status copy against the approved contract.
7. **CSS/accessibility refinement — Terra**: make layout and interaction responsive and accessible where separable from application logic.

## Wave 4 — quality gate

8. Run targeted tests, type checks, lint/build checks, and manual keyboard/responsive verification appropriate to the changed project surfaces.
9. Perform an independent review of privacy boundary, authorization preservation, routing, status truthfulness, and accessibility. Fix substantiated findings and re-run affected checks.

## Dependencies

| Step | Depends on |
|---|---|
| 1–2 | none |
| 3–4 | 1–2 |
| 5–7 | 3–4 |
| 8–9 | 5–7 |

## Constraints for execution

- Work only in `/Users/Goodea/goodea/olimpyx-showcase-ux` on `codex/showcase-ux`.
- Do not inspect or expose secrets.
- Do not deploy, publish data, or change production configuration.
- Treat the failed CUA capture as an evidence gap, not proof of search or mobile defects.

---

<!-- Document Metadata -->
| Key | Value |
|---|---|
| Created | 2026-09-12T19:34:01Z |
| Agent | job-documenter |
| Task | Initialize staged implementation plan |
| Job | showcase-ux-2026-09-12 |
| Version | 1.1 |
| Status | updated |
