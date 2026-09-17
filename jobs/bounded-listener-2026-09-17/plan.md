# Implementation Plan: Token-Efficient Daemonless Listener (`listen`)

- **Job ID:** `bounded-listener-2026-09-17`
- **Specification:** [`prd.md`](./prd.md)
- **Status:** In Progress
- **Target Branch:** `feat/daemonless-listener`

## Implementation Steps

### Step 1: Core Client Library Extension (`packages/client/src/client.js`)
- Add method `listen({ cursor, timeoutMs = 25_000, maxWaitMs = 15 * 60 * 1000, onHeartbeat, signal })`.
- Implement polling loop:
  - Check deadline `Date.now() < deadline` and `signal?.aborted`.
  - **Order of Operations:** Invoke `onHeartbeat()` at the start of each iteration *before* calling `wait()`, guaranteeing keepalive even if subsequent long-poll retries encounter backoff.
  - Calculate bounded slice for current iteration (bounded by remaining deadline and `timeoutMs`).
  - Reuse `this.wait({ cursor: currentCursor, timeoutMs: sliceMs })` with retry & backoff (1s, 2s, 4s up to 3 attempts on socket/network errors).
  - Ensure backoff sleep is cancellable via `signal` (aborts immediately if process termination arrives).
  - Break immediately if events are returned and return `{ status: 'received', data: page.data, page: page.page, waited_sec, poll_cycles }`.
  - If loop terminates due to deadline: return `{ status: 'idle_timeout', data: [], page: { next_cursor: currentCursor }, waited_sec, poll_cycles }`.

### Step 2: CLI Subcommand Integration (`packages/client/src/cli.js`)
- Register `listen` in command router.
- Parse options:
  - `--caller-id <ID>` (required)
  - `--max-wait-min <N>` (default: 15, range 1–60)
  - `--poll-timeout-sec <N>` (default: 25, range 5–30, bounded client-side by `OlimpyxClient.wait`)
  - `--after <CURSOR>` (optional cursor override)
- Register process signal handlers:
  - Trap `SIGINT` (Ctrl+C / cancellation) and `SIGTERM` (host abort).
  - Abort in-flight requests and backoff timers via `AbortController`.
  - Issue best-effort `POST /v1/sessions/:sessionId/end` with `{ reason: "agent_ended" }` (2s timeout).
  - Clear local session files via `state.clearSession()`, matching `session end` behavior.
  - Exit with standard Unix signal exit codes (130 / 143).
- Define `onHeartbeat` callback:
  - Invokes `POST /v1/sessions/:sessionId/heartbeat`.
  - Invokes `state.renewSession(callerId)`.
- Output sanitized JSON adhering strictly to PRD §5.6 schemas via `output()`.
- Preserve existing `wait` command untouched for backwards compatibility.

### Step 3: Test Suite Extension
- `packages/client/test/client.test.js`:
  - Test `client.listen()` immediate event receipt.
  - Test `client.listen()` multi-cycle wait with heartbeat callbacks.
  - Test `client.listen()` idle timeout completion.
  - Test retry on transient network errors.
- `packages/client/test/cli.test.js`:
  - Test `listen` subcommand execution and output.
  - Test heartbeat invocation during loop.
  - Test signal trapping and graceful cleanup.

### Step 4: Skill & Documentation Updates
- Update `skills/olimpyx-participant/SKILL.md` to instruct agents to use `listen` instead of cyclic `wait`.
- Re-run `install.test.js` to verify skill installer compatibility.
- Ensure `npm run typecheck` and `npm test` are clean.
