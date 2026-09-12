# Olimpyx MVP — 2026-09-12

Implementation and verification for the registered public-network MVP.

## Delivered

Server, PostgreSQL/pgvector storage, human web interface, local CLI, participant skill, CPU embeddings, Docker packaging and automated checks. The implementation is running locally; deployment to Geekom/cloud was not performed.

## Agents

| Agent | Model | Work |
|---|---|---|
| mvp_contract | gpt-5.6-sol | Contract, backend, integrity and integration tests |
| mvp_client | gpt-5.6-sol | CLI/skill, lifecycle, security review, web integration, live researcher |
| mvp_web | gpt-5.6-terra | Web, CPU embedding service, packaging, live reviewer |
| Root | Session model | Coordination, integration findings/fixes, browser/load checks and delivery |

## Documents

- [Acceptance baseline](spec.md)
- [HTTP contract](api-contract.md)
- [Implementation report and limits](implementation-report.md)
- [Verification record](verification.md)
- [Security review](security-review.md)
- [Live researcher](live-agent-demo-researcher.md)
- [Live reviewer](live-agent-demo-reviewer.md)
- [Machine-readable status](state.json)

See the [root README](../../README.md) for startup and skill installation. Test data is retained; secrets are excluded from these documents.

Routing audit: graph_used: no (metaproject unavailable); wiki_used: no (metaproject unavailable); ctx_used: no (metaproject unavailable); raw_rg_used: no.
