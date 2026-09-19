import type { Pool, PoolClient } from "pg";
import { envInt, LONGEST_LIMIT_WINDOW_SEC } from "./limits.js";

/** Fixed advisory-lock key so at most one replica prunes at a time (PRD §3.3 / plan Step 6). Exported for tests that need to hold it externally to prove `pruneOnce` skips. */
export const RETENTION_LOCK_KEY = "retention:prune";
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export type PruneCounts = {
  idempotency_keys: number;
  sessions: number;
  inbox_events: number;
  quota_events: number;
};

export type PruneResult = { skipped: true } | ({ skipped: false } & PruneCounts);

export type PruneLogger = { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };

type RetentionEnv = { idempotencyDays: number; sessionsDays: number; inboxDays: number; batchSize: number };

/** Rows deleted per statement; each batch is its own short statement so no single DELETE holds locks on a huge row set. */
export const DEFAULT_RETENTION_BATCH_SIZE = 5000;

/** Validates the retention env vars up front; throws before touching Postgres on any invalid value. */
function readRetentionEnv(env: Record<string, string | undefined>): RetentionEnv {
  return {
    idempotencyDays: envInt(env, "OLIMPYX_RETENTION_IDEMPOTENCY_DAYS", 7, 1),
    sessionsDays: envInt(env, "OLIMPYX_RETENTION_SESSIONS_DAYS", 30, 1),
    inboxDays: envInt(env, "OLIMPYX_RETENTION_INBOX_DAYS", 30, 1),
    batchSize: envInt(env, "OLIMPYX_RETENTION_BATCH_SIZE", DEFAULT_RETENTION_BATCH_SIZE, 1)
  };
}

/**
 * Deletes `table` rows matched by `where` (params from $2 on; $1 is the batch size) in batches of at most
 * `batchSize` via `ctid IN (SELECT ctid ... LIMIT $1)`, looping until a short batch. Returns the total deleted.
 */
async function deleteInBatches(client: PoolClient, table: string, alias: string, where: string, params: unknown[], batchSize: number): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await client.query(`DELETE FROM ${table} WHERE ctid IN (SELECT ${alias}.ctid FROM ${table} ${alias} WHERE ${where} LIMIT $1)`, [batchSize, ...params]);
    const n = r.rowCount ?? 0;
    total += n;
    if (n < batchSize) return total;
  }
}

/**
 * Runs one retention pass (PRD §3.3, plan Step 6) under a global `pg_try_advisory_lock`. If another
 * replica already holds the lock, returns `{ skipped: true }` immediately without deleting anything.
 * Env values are validated first and throw (before any DB call) on an invalid value. Every DELETE runs
 * in bounded batches (`OLIMPYX_RETENTION_BATCH_SIZE`, default 5000; `opts.batchSize` overrides for tests).
 */
export async function pruneOnce(pool: Pool, env: Record<string, string | undefined> = process.env, opts: { batchSize?: number } = {}): Promise<PruneResult> {
  const retention = readRetentionEnv(env);
  const { idempotencyDays, sessionsDays, inboxDays } = retention;
  const batchSize = opts.batchSize ?? retention.batchSize;

  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) locked", [RETENTION_LOCK_KEY]);
    if (!rows[0].locked) return { skipped: true };
    try {
      const idempotency = await deleteInBatches(client, "idempotency_keys", "k",
        "k.created_at < now() - make_interval(days => $2::int)", [idempotencyDays], batchSize);

      // Keeps each agent's single most-recent session (by last_heartbeat_at) regardless of age, so
      // last_seen_at (max(last_heartbeat_at) over an agent's sessions, used by profileFrom) never regresses to null.
      // The per-agent "latest" lookup is an index probe on idx_sessions_agent_heartbeat_id (agent_id, last_heartbeat_at DESC, id DESC).
      // The `id DESC` tie-break makes "latest" deterministic when two sessions share the exact same
      // last_heartbeat_at (e.g. both stamped by the same clock_timestamp() read): without it, Postgres
      // may pick either row for the kept exception, and the *other* tied row would then be deleted from
      // under whichever caller believed it was the kept one.
      const sessions = await deleteInBatches(client, "sessions", "s",
        `coalesce(s.ended_at, least(s.expires_at, s.last_heartbeat_at + interval '90 seconds')) < now() - make_interval(days => $2::int)
         AND s.id <> (SELECT x.id FROM sessions x WHERE x.agent_id = s.agent_id ORDER BY x.last_heartbeat_at DESC, x.id DESC LIMIT 1)`,
        [sessionsDays], batchSize);

      // Only acknowledged events are eligible: agent events against the ('agent', agent_id) checkpoint,
      // owner events against ('owner', owner_id). No checkpoint row => nothing for that actor is acknowledged.
      const inbox = await deleteInBatches(client, "inbox_events", "e",
        `e.occurred_at < now() - make_interval(days => $2::int)
         AND EXISTS (
           SELECT 1 FROM inbox_checkpoints c
           WHERE c.actor_type = CASE WHEN e.agent_id IS NOT NULL THEN 'agent' ELSE 'owner' END
             AND c.actor_id = coalesce(e.agent_id, e.owner_id)
             AND c.sequence >= e.sequence
         )`,
        [inboxDays], batchSize);

      // quota_events is a counter table (subscription_change), not durable inbox: prune unconditionally
      // past the longest quota window (currently 24h), regardless of OLIMPYX_RETENTION_* overrides.
      const quota = await deleteInBatches(client, "quota_events", "q",
        "q.created_at < now() - make_interval(secs => $2::int)", [LONGEST_LIMIT_WINDOW_SEC], batchSize);

      return { skipped: false, idempotency_keys: idempotency, sessions, inbox_events: inbox, quota_events: quota };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [RETENTION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

function poolOf(target: Pool | { pg: Pool }): Pool {
  return "pg" in target ? target.pg : target;
}

function loggerOf(target: Pool | { pg: Pool; log?: PruneLogger }, explicit?: PruneLogger): PruneLogger {
  if (explicit) return explicit;
  if ("log" in target && target.log) return target.log;
  return console;
}

/**
 * Starts the retention pruning loop: runs once immediately (at boot) and then every 6h via an
 * unref'd timer, so it never keeps the process alive on its own. Disabled entirely with
 * `OLIMPYX_PRUNE=off`. Throws synchronously on an invalid `OLIMPYX_RETENTION_*` value. Errors from a pass are logged, never thrown, so a bad pass doesn't crash the server.
 * Accepts either a `Pool` or an app-like object exposing `.pg` (and optionally `.log`).
 */
export function startPruning(
  target: Pool | { pg: Pool; log?: PruneLogger },
  env: Record<string, string | undefined> = process.env,
  log?: PruneLogger
): { stop: () => void } {
  const logger = loggerOf(target, log);
  if ((env.OLIMPYX_PRUNE ?? "").trim().toLowerCase() === "off") {
    return { stop: () => {} };
  }
  const pool = poolOf(target);
  // Fail fast at startup (synchronously, before the first pass) on an invalid OLIMPYX_RETENTION_* value;
  // a later bad pass would otherwise only be logged.
  readRetentionEnv(env);

  const run = async () => {
    try {
      const result = await pruneOnce(pool, env);
      if (result.skipped) logger.info({ skipped: true }, "retention prune skipped: another replica holds the lock");
      else logger.info(result, "retention prune completed");
    } catch (err) {
      logger.error({ err }, "retention prune failed");
    }
  };

  void run();
  const timer = setInterval(run, SIX_HOURS_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
