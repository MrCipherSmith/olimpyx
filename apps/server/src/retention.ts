import type { Pool } from "pg";
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

type RetentionEnv = { idempotencyDays: number; sessionsDays: number; inboxDays: number };

/** Validates the three retention env vars up front; throws before touching Postgres on any invalid value. */
function readRetentionEnv(env: Record<string, string | undefined>): RetentionEnv {
  return {
    idempotencyDays: envInt(env, "OLIMPYX_RETENTION_IDEMPOTENCY_DAYS", 7, 1),
    sessionsDays: envInt(env, "OLIMPYX_RETENTION_SESSIONS_DAYS", 30, 1),
    inboxDays: envInt(env, "OLIMPYX_RETENTION_INBOX_DAYS", 30, 1)
  };
}

/**
 * Runs one retention pass (PRD §3.3, plan Step 6) under a global `pg_try_advisory_lock`. If another
 * replica already holds the lock, returns `{ skipped: true }` immediately without deleting anything.
 * Env values are validated first and throw synchronously (before any DB call) on an invalid value.
 */
export async function pruneOnce(pool: Pool, env: Record<string, string | undefined> = process.env): Promise<PruneResult> {
  const { idempotencyDays, sessionsDays, inboxDays } = readRetentionEnv(env);

  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) locked", [RETENTION_LOCK_KEY]);
    if (!rows[0].locked) return { skipped: true };
    try {
      const idempotency = await client.query(
        "DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(days => $1::int)",
        [idempotencyDays]
      );

      // Keeps each agent's single most-recent session (by last_heartbeat_at) regardless of age, so
      // last_seen_at (max(last_heartbeat_at) over an agent's sessions, used by profileFrom) never regresses to null.
      const sessions = await client.query(
        `DELETE FROM sessions s
         WHERE coalesce(ended_at, least(expires_at, last_heartbeat_at + interval '90 seconds')) < now() - make_interval(days => $1::int)
           AND s.id <> (SELECT id FROM sessions x WHERE x.agent_id = s.agent_id ORDER BY last_heartbeat_at DESC LIMIT 1)`,
        [sessionsDays]
      );

      // Only acknowledged events are eligible: agent events against the ('agent', agent_id) checkpoint,
      // owner events against ('owner', owner_id). No checkpoint row => nothing for that actor is acknowledged.
      const inbox = await client.query(
        `DELETE FROM inbox_events e
         WHERE e.occurred_at < now() - make_interval(days => $1::int)
           AND EXISTS (
             SELECT 1 FROM inbox_checkpoints c
             WHERE c.actor_type = CASE WHEN e.agent_id IS NOT NULL THEN 'agent' ELSE 'owner' END
               AND c.actor_id = coalesce(e.agent_id, e.owner_id)
               AND c.sequence >= e.sequence
           )`,
        [inboxDays]
      );

      // quota_events is a counter table (subscription_change), not durable inbox: prune unconditionally
      // past the longest quota window (currently 24h), regardless of OLIMPYX_RETENTION_* overrides.
      const quota = await client.query(
        `DELETE FROM quota_events WHERE created_at < now() - make_interval(secs => $1::int)`,
        [LONGEST_LIMIT_WINDOW_SEC]
      );

      return {
        skipped: false,
        idempotency_keys: idempotency.rowCount ?? 0,
        sessions: sessions.rowCount ?? 0,
        inbox_events: inbox.rowCount ?? 0,
        quota_events: quota.rowCount ?? 0
      };
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
 * `OLIMPYX_PRUNE=off`. Errors from a pass are logged, never thrown, so a bad pass doesn't crash the server.
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
