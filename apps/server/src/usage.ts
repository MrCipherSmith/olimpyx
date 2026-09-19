import type { Pool, PoolClient } from "pg";
import { windowUsage, type LimitsConfig } from "./limits.js";

// Owner-visible contribution counters (PRD §3.5). Descriptive only: never public, never a score, never changes a limit (Q-025).
type Db = Pool | PoolClient;
const COUNTERS = ["messages", "replies_in_other_threads", "own_threads_resolved", "knowledge_cards", "knowledge_versions", "reviews_given", "tasks_completed_for_others"] as const;
type Counters = Record<typeof COUNTERS[number], number>;
const PERIODS = { days_7: 7, days_30: 30 } as const;

const zero = (): Counters => Object.fromEntries(COUNTERS.map(c => [c, 0])) as Counters;

/** One grouped query per counter for all `agentIds`; returns per-agent counters for 7 and 30 days. */
async function contributionCounters(db: Db, agentIds: string[]) {
  const result = new Map<string, Record<keyof typeof PERIODS, Counters>>(agentIds.map(id => [id, { days_7: zero(), days_30: zero() }]));
  if (!agentIds.length) return result;
  const window = (column: string) => `count(*) FILTER (WHERE ${column}>now()-interval '7 days')::int d7, count(*) FILTER (WHERE ${column}>now()-interval '30 days')::int d30`;
  const queries: Record<typeof COUNTERS[number], string> = {
    messages: `SELECT sender_id a,${window("created_at")} FROM messages WHERE sender_type='agent' AND sender_id=ANY($1) AND created_at>now()-interval '30 days' GROUP BY 1`,
    replies_in_other_threads: `SELECT m.sender_id a,${window("m.created_at")} FROM messages m JOIN messages r ON r.id=m.root_message_id WHERE m.sender_type='agent' AND m.sender_id=ANY($1) AND NOT (r.sender_type='agent' AND r.sender_id=m.sender_id) AND m.created_at>now()-interval '30 days' GROUP BY 1`,
    own_threads_resolved: `SELECT sender_id a,${window("resolved_at")} FROM messages WHERE sender_type='agent' AND sender_id=ANY($1) AND root_message_id IS NULL AND category IS NOT NULL AND status='resolved' AND resolved_at>now()-interval '30 days' GROUP BY 1`,
    knowledge_cards: `SELECT author_agent_id a,${window("created_at")} FROM knowledge_cards WHERE author_agent_id=ANY($1) AND created_at>now()-interval '30 days' GROUP BY 1`,
    knowledge_versions: `SELECT author_agent_id a,${window("created_at")} FROM knowledge_versions WHERE author_agent_id=ANY($1) AND version>1 AND created_at>now()-interval '30 days' GROUP BY 1`,
    reviews_given: `SELECT reviewer_agent_id a,${window("created_at")} FROM knowledge_reviews WHERE reviewer_agent_id=ANY($1) AND created_at>now()-interval '30 days' GROUP BY 1`,
    tasks_completed_for_others: `SELECT t.assigned_agent_id a,${window("t.updated_at")} FROM tasks t JOIN agents asg ON asg.id=t.assigned_agent_id LEFT JOIN agents ca ON t.creator_type='agent' AND ca.id=t.creator_id
      WHERE t.assigned_agent_id=ANY($1) AND t.status='completed' AND t.updated_at>now()-interval '30 days' AND (CASE WHEN t.creator_type='owner' THEN t.creator_id ELSE ca.owner_id END) IS DISTINCT FROM asg.owner_id GROUP BY 1`
  };
  for (const counter of COUNTERS) {
    for (const row of (await db.query(queries[counter], [agentIds])).rows) {
      const entry = result.get(row.a);
      if (!entry) continue;
      entry.days_7[counter] = Number(row.d7);
      entry.days_30[counter] = Number(row.d30);
    }
  }
  return result;
}

export async function agentUsage(db: Db, config: LimitsConfig, agentId: string) {
  const counters = (await contributionCounters(db, [agentId])).get(agentId)!;
  return { agent_id: agentId, window: await windowUsage(db, config, "agent", agentId), counters };
}

/** Per agent of the owner, plus the owner aggregate (window usage includes the owner's human posts; counters sum the agents). */
export async function ownerUsage(db: Db, config: LimitsConfig, ownerId: string) {
  const agents = (await db.query("SELECT id,name,revoked_at FROM agents WHERE owner_id=$1 ORDER BY created_at,id", [ownerId])).rows;
  const counters = await contributionCounters(db, agents.map(a => a.id));
  const total = { days_7: zero(), days_30: zero() };
  const perAgent = [];
  for (const a of agents) {
    const c = counters.get(a.id)!;
    for (const period of Object.keys(PERIODS) as Array<keyof typeof PERIODS>) for (const counter of COUNTERS) total[period][counter] += c[period][counter];
    perAgent.push({ agent_id: a.id, name: a.name, revoked: a.revoked_at !== null, window: await windowUsage(db, config, "agent", a.id), counters: c });
  }
  return { owner: { owner_id: ownerId, window: await windowUsage(db, config, "owner", ownerId), counters: total }, agents: perAgent };
}
