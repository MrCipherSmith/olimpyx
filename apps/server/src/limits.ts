import type { Pool, PoolClient } from "pg";
import { ApiError } from "./errors.js";
import type { Principal } from "./types.js";

// Server traffic and capacity limits (D-045 / Q-016). Counted over existing rows under a per-owner advisory lock;
// the caller owns the transaction, which must commit the counted row. Lock order everywhere: idem → spam → quota → memory.
// Counted rows are stamped with clock_timestamp(), not now(): now() is the transaction start, which may precede a long
// wait on the quota lock, so a now()-stamped row could land "in the past" relative to rows another request already counted.

export const QUOTA_ACTIONS = ["message", "reply", "direct_message", "help_thread", "room_create", "knowledge_card", "knowledge_version", "knowledge_review", "task_create", "report", "subscription_change"] as const;
export type QuotaAction = typeof QUOTA_ACTIONS[number];
export type QuotaScope = "agent" | "owner";
type Db = Pool | PoolClient;

export type ActionLimit = { window: number; agent: number; owner: number };
const HOUR = 3600, DAY = 86400;

/** PRD §4 defaults (owner-approved 2026-09-19). `0` disables a limit. */
export const LIMITS: Readonly<Record<QuotaAction, ActionLimit>> = {
  message: { window: HOUR, agent: 60, owner: 200 },
  reply: { window: HOUR, agent: 120, owner: 300 },
  direct_message: { window: HOUR, agent: 30, owner: 100 },
  help_thread: { window: HOUR, agent: 10, owner: 30 },
  room_create: { window: DAY, agent: 5, owner: 10 },
  knowledge_card: { window: DAY, agent: 20, owner: 50 },
  knowledge_version: { window: DAY, agent: 30, owner: 80 },
  knowledge_review: { window: DAY, agent: 60, owner: 150 },
  task_create: { window: DAY, agent: 20, owner: 50 },
  report: { window: HOUR, agent: 10, owner: 20 },
  subscription_change: { window: HOUR, agent: 30, owner: 60 }
};
export const DIRECT_MESSAGE_PAIR = 10;
export const CAPACITY = { agents_per_owner: 10, enrollment_tokens_per_owner: 5, sessions_per_agent: 3, open_tasks_per_assignee: 20 };
export type Capacity = typeof CAPACITY;

export type LimitsConfig = { actions: Record<QuotaAction, ActionLimit>; directMessagePair: number; capacity: Capacity };

/** Exported for reuse by retention.ts's own env validation (same fail-fast contract). */
export function envInt(env: Record<string, string | undefined>, name: string, fallback: number, min = 0) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < min || !Number.isSafeInteger(Number(raw))) throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  return Number(raw);
}

/** The longest action window (§3.1), currently the 24h daily actions. Retention prunes `quota_events` past this. */
export const LONGEST_LIMIT_WINDOW_SEC: number = Math.max(...Object.values(LIMITS).map(l => l.window));

/** Reads `OLIMPYX_LIMIT_<ACTION>_<AGENT|OWNER>`, `OLIMPYX_LIMIT_DIRECT_MESSAGE_PAIR` and `OLIMPYX_CAP_*`; throws on invalid values (fail fast at startup). */
export function loadLimits(env: Record<string, string | undefined> = process.env): LimitsConfig {
  const actions = {} as Record<QuotaAction, ActionLimit>;
  for (const action of QUOTA_ACTIONS) {
    const name = `OLIMPYX_LIMIT_${action.toUpperCase()}`, base = LIMITS[action];
    actions[action] = { window: base.window, agent: envInt(env, `${name}_AGENT`, base.agent), owner: envInt(env, `${name}_OWNER`, base.owner) };
  }
  return {
    actions,
    directMessagePair: envInt(env, "OLIMPYX_LIMIT_DIRECT_MESSAGE_PAIR", DIRECT_MESSAGE_PAIR),
    capacity: {
      agents_per_owner: envInt(env, "OLIMPYX_CAP_AGENTS_PER_OWNER", CAPACITY.agents_per_owner),
      enrollment_tokens_per_owner: envInt(env, "OLIMPYX_CAP_ENROLLMENT_TOKENS_PER_OWNER", CAPACITY.enrollment_tokens_per_owner),
      sessions_per_agent: envInt(env, "OLIMPYX_CAP_SESSIONS_PER_AGENT", CAPACITY.sessions_per_agent, 1),
      open_tasks_per_assignee: envInt(env, "OLIMPYX_CAP_OPEN_TASKS_PER_ASSIGNEE", CAPACITY.open_tasks_per_assignee)
    }
  };
}

/** Read-only view for `GET /v1/limits` and bootstrap. */
export function effectiveLimits(config: LimitsConfig) {
  const actions = Object.fromEntries(QUOTA_ACTIONS.map(a => [a, { window_sec: config.actions[a].window, agent: config.actions[a].agent, owner: config.actions[a].owner }]));
  return { actions, direct_message_pair: { window_sec: HOUR, limit: config.directMessagePair }, capacity: { ...config.capacity } };
}

export type QuotaDetails = { action: string; scope: QuotaScope; limit: number; window_sec: number; retry_after_sec: number };

export class QuotaError extends ApiError {
  constructor(readonly quota: QuotaDetails) {
    super(429, "quota_exceeded", `Quota exceeded for ${quota.action}: maximum ${quota.limit} per ${quota.window_sec} seconds (${quota.scope})`, quota, { "Retry-After": String(quota.retry_after_sec) });
    this.name = "QuotaError";
  }
}

const OWNER_AGENTS = "SELECT id FROM agents WHERE owner_id=$1";
/**
 * Agent scope: the agent's own rows. Owner scope: every agent of the owner plus the owner's own human rows.
 * `agents` (usage reporting only): the rows of every agent id in the array `$1`, grouped by the caller on column `a`.
 */
type CountScope = QuotaScope | "agents";
const actorFilter = (prefix: string, scope: CountScope) => scope === "agent"
  ? `${prefix}_type='agent' AND ${prefix}_id=$1`
  : scope === "agents" ? `${prefix}_type='agent' AND ${prefix}_id=ANY($1)`
  : `((${prefix}_type='agent' AND ${prefix}_id IN (${OWNER_AGENTS})) OR (${prefix}_type='owner' AND ${prefix}_id=$1))`;
const authorFilter = (column: string, scope: CountScope) => scope === "agent" ? `${column}=$1` : scope === "agents" ? `${column}=ANY($1)` : `${column} IN (${OWNER_AGENTS})`;

/** Message classes are mutually exclusive, checked in this precedence: direct message, reply, help thread, plain message. */
export const MESSAGE_CLASS: Record<"direct_message" | "reply" | "help_thread" | "message", string> = {
  direct_message: "recipient_agent_id IS NOT NULL",
  reply: "recipient_agent_id IS NULL AND reply_to_message_id IS NOT NULL",
  help_thread: "recipient_agent_id IS NULL AND reply_to_message_id IS NULL AND category IS NOT NULL",
  message: "recipient_agent_id IS NULL AND reply_to_message_id IS NULL AND category IS NULL"
};
export const messageClassOf = (m: { recipient_agent_id?: string | null; reply_to_message_id?: string | null; category?: string | null }): keyof typeof MESSAGE_CLASS =>
  m.recipient_agent_id ? "direct_message" : m.reply_to_message_id ? "reply" : m.category ? "help_thread" : "message";

/** SQL yielding one row per counted event since `$2` — its time `t` and its actor id `a` — for `$1` (agent id, owner id, or agent id array). */
function eventTimes(action: QuotaAction, scope: CountScope): string {
  switch (action) {
    case "message": case "reply": case "direct_message": case "help_thread":
      return `SELECT created_at t, sender_id a FROM messages WHERE ${actorFilter("sender", scope)} AND ${MESSAGE_CLASS[action]} AND created_at>$2`;
    case "room_create": return `SELECT created_at t, creator_id a FROM rooms WHERE ${actorFilter("creator", scope)} AND created_at>$2`;
    case "task_create": return `SELECT created_at t, creator_id a FROM tasks WHERE ${actorFilter("creator", scope)} AND created_at>$2`;
    case "report": return `SELECT created_at t, reporter_id a FROM reports WHERE ${actorFilter("reporter", scope)} AND created_at>$2`;
    case "knowledge_card": return `SELECT created_at t, author_agent_id a FROM knowledge_cards WHERE ${authorFilter("author_agent_id", scope)} AND created_at>$2`;
    case "knowledge_version": return `SELECT created_at t, author_agent_id a FROM knowledge_versions WHERE ${authorFilter("author_agent_id", scope)} AND version>1 AND created_at>$2`;
    // Reviews are upserts that reset created_at; each archived revision keeps its own submission time.
    case "knowledge_review": return `SELECT created_at t, reviewer_agent_id a FROM knowledge_reviews WHERE ${authorFilter("reviewer_agent_id", scope)} AND created_at>$2
      UNION ALL SELECT rr.created_at, kr.reviewer_agent_id FROM knowledge_review_revisions rr JOIN knowledge_reviews kr ON kr.id=rr.review_id WHERE ${authorFilter("kr.reviewer_agent_id", scope)} AND rr.created_at>$2`;
    case "subscription_change": return scope === "owner"
      ? "SELECT created_at t, actor_id a FROM quota_events WHERE action='subscription_change' AND owner_id=$1 AND created_at>$2"
      : `SELECT created_at t, actor_id a FROM quota_events WHERE action='subscription_change' AND actor_type='agent' AND actor_id${scope === "agent" ? "=$1" : "=ANY($1)"} AND created_at>$2`;
  }
}

const PAIR_TIMES = "SELECT created_at t FROM messages WHERE sender_type=$3 AND sender_id=$1 AND recipient_agent_id=$4 AND created_at>$2";

export async function lockOwnerQuota(client: PoolClient, ownerId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`quota:${ownerId}`]);
}

async function clockNow(client: Db): Promise<Date> {
  return (await client.query("SELECT clock_timestamp() t")).rows[0].t;
}

async function check(client: PoolClient, sql: string, params: unknown[], at: Date, quota: Omit<QuotaDetails, "retry_after_sec">) {
  const since = new Date(at.getTime() - quota.window_sec * 1000);
  const args = [params[0], since, ...params.slice(1)];
  const used = Number((await client.query(`SELECT count(*)::int n FROM (${sql}) s`, args)).rows[0].n);
  if (used < quota.limit) return;
  // The row at OFFSET (used - limit) must leave the window before one more event fits, even after a limit was lowered.
  const pivot = (await client.query(`SELECT t FROM (${sql}) s ORDER BY t ASC OFFSET ${used - quota.limit} LIMIT 1`, args)).rows[0]?.t as Date | undefined;
  const retry = pivot ? Math.ceil((new Date(pivot).getTime() + quota.window_sec * 1000 - at.getTime()) / 1000) : quota.window_sec;
  throw new QuotaError({ ...quota, retry_after_sec: Math.min(quota.window_sec, Math.max(1, retry)) });
}

/**
 * Checks the agent limit, then the owner aggregate (then the direct-message pair limit) for `action`.
 * Runs on the transaction that will commit the counted row, after `lockOwnerQuota`. Throws `QuotaError`.
 */
export async function enforceQuota(client: PoolClient, config: LimitsConfig, p: Principal, action: QuotaAction, extra: { recipientAgentId?: string | null } = {}) {
  await lockOwnerQuota(client, p.ownerId);
  const at = await clockNow(client), spec = config.actions[action];
  if (p.type === "agent" && spec.agent > 0) await check(client, eventTimes(action, "agent"), [p.id], at, { action, scope: "agent", limit: spec.agent, window_sec: spec.window });
  if (spec.owner > 0) await check(client, eventTimes(action, "owner"), [p.ownerId], at, { action, scope: "owner", limit: spec.owner, window_sec: spec.window });
  if (action === "direct_message" && extra.recipientAgentId && config.directMessagePair > 0) {
    await check(client, PAIR_TIMES, [p.id, p.type, extra.recipientAgentId], at, { action: "direct_message_pair", scope: p.type, limit: config.directMessagePair, window_sec: HOUR });
  }
}

/** Append-only counter row for actions without a natural countable row (today only `subscription_change`). */
export async function recordQuotaEvent(client: PoolClient, p: Principal, action: QuotaAction) {
  await client.query("INSERT INTO quota_events(action,actor_type,actor_id,owner_id,created_at) VALUES($1,$2,$3,$4,clock_timestamp())", [action, p.type, p.id, p.ownerId]);
}

/** Current window usage against every limit, for one scope. */
export async function windowUsage(db: Db, config: LimitsConfig, scope: QuotaScope, actorId: string) {
  const at = await clockNow(db), usage: Record<string, { used: number; limit: number; window_sec: number }> = {};
  for (const action of QUOTA_ACTIONS) {
    const spec = config.actions[action], since = new Date(at.getTime() - spec.window * 1000);
    const used = Number((await db.query(`SELECT count(*)::int n FROM (${eventTimes(action, scope)}) s`, [actorId, since])).rows[0].n);
    usage[action] = { used, limit: scope === "agent" ? spec.agent : spec.owner, window_sec: spec.window };
  }
  return usage;
}

type WindowUsage = Awaited<ReturnType<typeof windowUsage>>;

/** Agent-scope window usage for many agents at once: one grouped query per action, independent of the number of agents. */
export async function agentsWindowUsage(db: Db, config: LimitsConfig, agentIds: string[]): Promise<Map<string, WindowUsage>> {
  const result = new Map<string, WindowUsage>();
  if (!agentIds.length) return result;
  const at = await clockNow(db);
  for (const id of agentIds) result.set(id, {});
  for (const action of QUOTA_ACTIONS) {
    const spec = config.actions[action], since = new Date(at.getTime() - spec.window * 1000);
    const counts = new Map<string, number>();
    for (const row of (await db.query(`SELECT a, count(*)::int n FROM (${eventTimes(action, "agents")}) s GROUP BY a`, [agentIds, since])).rows) counts.set(row.a, Number(row.n));
    for (const id of agentIds) result.get(id)![action] = { used: counts.get(id) ?? 0, limit: spec.agent, window_sec: spec.window };
  }
  return result;
}
