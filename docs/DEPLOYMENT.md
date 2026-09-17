# Production deployment

This document describes how Olimpyx is deployed in production today. It supersedes the
older "no Geekom deployment is claimed" line in
[`jobs/mvp-2026-09-12/verification.md`](../jobs/mvp-2026-09-12/verification.md),
which was written before the CI/CD pipeline landed.

## Topology

| Layer | Component | Where |
|---|---|---|
| DNS / TLS | Cloudflare | `olimpyx.mrciphersmith.com` |
| Origin | Olimpyx API + Web (Docker Compose) | Geekom mini-PC, self-hosted GitHub runner |
| Database | `pgvector/pgvector:pg17` | Same host, Docker volume `olimpyx-db` |
| Embeddings | Optional CPU service | Same host, **not running** by default (see below) |

The public URL `https://olimpyx.mrciphersmith.com/` terminates at Cloudflare and
proxies to the Geekom host via the local port `4173` (web) and `4300` (api).

## Pipeline

1. **Trigger**: every push to `main` runs `.github/workflows/deploy.yml`.
2. **Validate**: the `validate-ref` job asserts `github.ref == refs/heads/main`.
3. **Test**: the `test` job calls `.github/workflows/check.yml` as a reusable
   workflow via `uses: ./.github/workflows/check.yml`. The CI workflow runs
   typecheck, unit tests, build, compose config, image build, Playwright install,
   API+web smoke, live and live-cli client tests, and Playwright e2e.
4. **Deploy**: the `deploy-geekom` job runs on the self-hosted runner
   `olimpyx-deploy` (label `[self-hosted, Linux, X64, olimpyx-deploy]`) inside
   the GitHub Environment `production-geekom`. Concurrency group
   `production-olimpyx-geekom` serialises deployments so a slow deploy cannot
   overlap a fresh one.

The deploy script [`deploy/deploy-geekom.sh`](../deploy/deploy-geekom.sh):

1. Resolves the source (`/home/altsay/olimpyx`) and target (`/home/altsay/olimpyx-deploy`)
   directories on the runner.
2. Clones the deploy checkout if missing, then `git fetch origin <sha>`.
3. Reads the previously successful SHA from `~/.local/state/olimpyx-deploy/last-successful-sha`
   and validates both SHAs are full 40-character hex.
4. Syncs runtime files (`compose.override.yaml`, `.env`) from the source tree to
   the deploy tree if they exist. **No secrets leave the source tree if the
   runner's source dir is empty.**
5. `git reset --hard $deploy_sha` on the deploy tree.
6. `docker compose build --pull api web` then
   `docker compose up -d --wait --wait-timeout 120 db api web`.
7. Health-checks `http://127.0.0.1:4173/health/ready` and
   `https://olimpyx.mrciphersmith.com/health/ready`.
8. Atomically updates `last-successful-sha` only after both healthchecks pass.

## Rollback

`deploy-geekom.sh` registers `trap rollback ERR`. If any step fails the trap:

1. Prints `compose logs --tail 100 api web` to stderr.
2. `git reset --hard $previous_sha` on the deploy tree.
3. Re-syncs runtime files.
4. `compose build api web` and `compose up -d --wait --wait-timeout 120 db api web`.
5. Re-checks both health endpoints (15 attempts × 2s).
6. If rollback also fails: exit code 70, manual recovery required.

The atomic `mv $temporary_state $last_successful_file` on success means a partial
or failed deploy never advances the last-successful pointer, so the next push
falls back to a known-good SHA.

## Health endpoints

| Endpoint | Purpose | Example |
|---|---|---|
| `GET /health/live` | Liveness — process is up | `{"status":"ok"}` |
| `GET /health/ready` | Readiness — DB reachable, app initialised | `{"status":"ready","database":"ok","embedding":"unavailable"}` |

The deploy script requires `ready` (not just `live`) before declaring success.

## Known limitations on production

| Item | Status | Why |
|---|---|---|
| `embedding: unavailable` in `/health/ready` | By design | `compose.yaml:57` declares the `embeddings` service under `profiles: ["embeddings"]`. It is opt-in: `docker compose --profile embeddings up`. CPU embeddings are dev/CI tooling (see [`scripts/semantic-check.mjs`](../scripts/semantic-check.mjs) and [`jobs/mvp-2026-09-12/verification.md`](../jobs/mvp-2026-09-12/verification.md)). On production the API returns `embedding: unavailable` and falls back to lexical search. |
| `MODERATOR_TOKEN` empty on production | By design | The platform moderator agent is not shipped; moderation runs through the deterministic observer and manual resolve (see [`jobs/mvp-2026-09-12/implementation-report.md`](../jobs/mvp-2026-09-12/implementation-report.md), "Moderation inference is not shipped"). |
| No HTTPS on internal port `4173` | By design | Cloudflare terminates TLS in front; the Geekom host listens on plain HTTP on `127.0.0.1`. |
| Single host, no redundancy | By design | The Geekom deploy is a single-node MVP. The compose file declares only one `db`, one `api`, one `web`. High-availability / multi-region is explicitly out of scope per [`docs/ROADMAP.md` Horizon 3](./ROADMAP.md). |

## Operational checklist

- **Trigger a manual deploy**: in the GitHub Actions tab, "Deploy" workflow →
  "Run workflow" → branch `main`. The job runs `test` first; only on `success`
  does it reach `deploy-geekom`.
- **Trigger a manual rollback**:
  1. On the runner, read `~/.local/state/olimpyx-deploy/last-successful-sha`.
  2. SSH to the runner, run
     `cd /home/altsay/olimpyx-deploy && git reset --hard <previous-sha> && docker compose build --pull api web && docker compose up -d --wait --wait-timeout 120 db api web`.
  3. Re-check `curl -fsS https://olimpyx.mrciphersmith.com/health/ready`.
- **Inspect recent deploys**:
  `gh run list --workflow=deploy.yml --branch=main --limit 10`.
- **Production health**:
  `curl -fsS https://olimpyx.mrciphersmith.com/health/ready`.

## History

| Date (UTC) | Event | Source |
|---|---|---|
| 2026-09-13 | First deploy of showcase UX (PR #2) | `8d800ee` (CI automation) + `9b4256f` (showcase UX) |
| 2026-09-13 → 2026-09-13 | Successive deploys of PR #3–#7 (showcase policy, room-scroll, UI followup, knowledge-card spacing, mobile-room-focus) | merged PR history |
| 2026-09-17 | PR #8 (dynamic showcase publication docs) deployed | `66aa7e4` |
| 2026-09-17 | PR #9 (nightly load/expiry split) deployed | `89135ec` |
| 2026-09-17 | ROADMAP docs update deployed | `cbd1452` |

The full list of deploy runs is visible under
`gh run list --workflow=deploy.yml --branch=main`.
