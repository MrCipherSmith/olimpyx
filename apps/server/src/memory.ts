import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Principal } from "./app.js";
import { detectSecret } from "./secret-scan.js";
import type { MemoryCreateInput } from "./validation.js";

// Operational-memory write rules (D-044 / Q-008). The server enforces deterministic rules only; agents author content.
export const KNOWLEDGE_LIMIT = 500;
export const INFLUENCE_LIMIT = 50;
export const WRITES_PER_HOUR = 30;
const INFLUENCE = "personality_influence";
const BOOTSTRAP_RECENT = 5;

type Db = Pool | PoolClient;
type MemoryEventType = "created" | "deduplicated" | "superseded" | "archived" | "reactivated" | "consolidated" | "rolled_back";

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export class MemoryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>, readonly headers?: Record<string, string>) {
    super(message);
    this.name = "MemoryError";
  }
}

export function assertNoSecrets(values: unknown[]) {
  const kind = detectSecret(values);
  if (kind) throw new MemoryError(422, "secret_detected", `Memory content refused: detected ${kind}. Remove the secret; credentials must never be stored in memory.`, { kind });
}

export function computeMemoryFingerprint(kind: string, summary: string) {
  return crypto.createHash("sha256").update(`${kind}:${summary.trim().toLowerCase().replace(/\s+/g, " ")}`).digest("hex");
}

export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (m) => `\\${m}`);

export function memoryFrom(x: any) {
  return {
    memory_id: x.id, agent_id: x.agent_id, kind: x.kind, summary: x.summary, body: x.body,
    tags: Array.isArray(x.tags) ? x.tags : [], confidence: x.confidence ?? null,
    active: x.active, archived_reason: x.archived_reason ?? null, persona_revision: x.persona_revision ?? null,
    supersedes_id: x.supersedes_id ?? null, superseded_by: x.superseded_by ?? null, consolidated_into: x.consolidated_into ?? null,
    source_ref: x.source_ref ?? null, created_at: x.created_at
  };
}

const eventFrom = (x: any) => ({ event_id: x.id, agent_id: x.agent_id, type: x.type, actor: { actor_type: x.actor_type, actor_id: x.actor_id }, memory_ids: x.memory_ids, summary_id: x.summary_id, reason: x.reason, created_at: x.created_at });

export async function lockAgentMemory(client: PoolClient, agentId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memory:${agentId}`]);
}

export async function recordMemoryEvent(client: Db, event: { agentId: string; type: MemoryEventType; principal: Principal; memoryIds: string[]; summaryId?: string | null; reason?: string | null }) {
  await client.query(
    "INSERT INTO memory_events(id,agent_id,type,actor_type,actor_id,memory_ids,summary_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [newId("mev"), event.agentId, event.type, event.principal.type, event.principal.id, JSON.stringify(event.memoryIds), event.summaryId ?? null, event.reason ?? null]
  );
}

export async function activeCounts(db: Db, agentId: string) {
  const r = await db.query("SELECT count(*) FILTER (WHERE kind<>$2)::int knowledge,count(*) FILTER (WHERE kind=$2)::int influence FROM memories WHERE agent_id=$1 AND active", [agentId, INFLUENCE]);
  return { knowledge: Number(r.rows[0].knowledge), influence: Number(r.rows[0].influence) };
}

async function assertCapacity(client: PoolClient, agentId: string, kind: string) {
  const counts = await activeCounts(client, agentId);
  if (kind === INFLUENCE && counts.influence >= INFLUENCE_LIMIT) throw new MemoryError(409, "influence_limit_reached", `Active personality influences are limited to ${INFLUENCE_LIMIT}; the owner must roll back or archive influences first`);
  if (kind !== INFLUENCE && counts.knowledge >= KNOWLEDGE_LIMIT) throw new MemoryError(409, "memory_consolidation_required", `Active knowledge memories are limited to ${KNOWLEDGE_LIMIT}; consolidate or archive memories first`);
}

/** PRD §3.2 steps 2–7. The caller owns the transaction and must hold lockAgentMemory(). */
export async function writeMemory(client: PoolClient, p: Principal, agentId: string, input: MemoryCreateInput): Promise<{ status: 200 | 201; data: Record<string, unknown> }> {
  assertNoSecrets([input.summary, input.body, input.tags, input.source_ref]);
  let target: { id: string; kind: string; active: boolean } | null = null;
  if (input.supersedes_id) {
    target = (await client.query("SELECT id,kind,active FROM memories WHERE id=$1 AND agent_id=$2 FOR UPDATE", [input.supersedes_id, agentId])).rows[0] ?? null;
    if (!target) throw new MemoryError(404, "not_found", "Superseded memory not found");
    if (!target.active) throw new MemoryError(409, "memory_not_active", "Superseded memory is not active");
    if (target.kind !== input.kind) throw new MemoryError(409, "kind_mismatch", "A memory can only be superseded by one of the same kind");
  }
  const fingerprint = computeMemoryFingerprint(input.kind, input.summary);
  if (!target) {
    const dup = (await client.query("SELECT * FROM memories WHERE agent_id=$1 AND fingerprint=$2 AND active AND created_at>now()-interval '24 hours' ORDER BY created_at DESC,id DESC LIMIT 1", [agentId, fingerprint])).rows[0];
    if (dup) {
      await recordMemoryEvent(client, { agentId, type: "deduplicated", principal: p, memoryIds: [dup.id] });
      return { status: 200, data: { ...memoryFrom(dup), deduplicated: true } };
    }
  }
  const rate = (await client.query("SELECT count(*)::int n,ceil(extract(epoch FROM min(created_at)+interval '1 hour'-now()))::int retry FROM memories WHERE agent_id=$1 AND created_at>now()-interval '1 hour'", [agentId])).rows[0];
  if (Number(rate.n) >= WRITES_PER_HOUR) {
    const retry = Math.max(1, Number(rate.retry) || 1);
    throw new MemoryError(429, "quota_exceeded", `Memory write quota exceeded: maximum ${WRITES_PER_HOUR} memories per hour`, { retry_after_sec: retry }, { "Retry-After": String(retry) });
  }
  const active = input.active ?? true;
  if (!target && active) await assertCapacity(client, agentId, input.kind);
  const mid = newId("mem");
  const inserted = (await client.query(
    `INSERT INTO memories(id,agent_id,kind,summary,body,active,source_ref,created_at,tags,confidence,persona_revision,supersedes_id,fingerprint,archived_reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11,$12,$13) RETURNING *`,
    [mid, agentId, input.kind, input.summary, input.body, active, input.source_ref === undefined ? null : JSON.stringify(input.source_ref), JSON.stringify([...new Set(input.tags ?? [])]), input.confidence ?? null, input.persona_revision ?? null, target?.id ?? null, fingerprint, active ? null : "manual"]
  )).rows[0];
  await recordMemoryEvent(client, { agentId, type: "created", principal: p, memoryIds: [mid] });
  if (target) {
    const updated = await client.query("UPDATE memories SET active=false,superseded_by=$1,archived_reason='superseded' WHERE id=$2 AND agent_id=$3 AND active", [mid, target.id, agentId]);
    if (updated.rowCount !== 1) throw new MemoryError(409, "memory_not_active", "Superseded memory is not active");
    await recordMemoryEvent(client, { agentId, type: "superseded", principal: p, memoryIds: [target.id, mid] });
  }
  return { status: 201, data: { ...memoryFrom(inserted), deduplicated: false } };
}

export async function getMemory(db: Db, agentId: string, memoryId: string) {
  const r = await db.query("SELECT * FROM memories WHERE id=$1 AND agent_id=$2", [memoryId, agentId]);
  if (!r.rowCount) throw new MemoryError(404, "not_found", "Memory not found");
  return memoryFrom(r.rows[0]);
}

export async function listMemories(db: Db, agentId: string, query: { status: "active" | "archived" | "all"; kind?: string; tag?: string; q?: string; cursor?: string; limit: number }) {
  const params: unknown[] = [agentId], clauses = ["agent_id=$1"];
  const param = (value: unknown) => { params.push(value); return `$${params.length}`; };
  if (query.status === "active") clauses.push("active");
  else if (query.status === "archived") clauses.push("NOT active");
  if (query.kind) clauses.push(`kind=${param(query.kind)}`);
  if (query.tag) clauses.push(`tags @> ${param(JSON.stringify([query.tag]))}::jsonb`);
  if (query.q) {
    const nodes = Number((await db.query("SELECT numnode(websearch_to_tsquery('simple',$1))::int n", [query.q])).rows[0].n);
    if (nodes > 0) clauses.push(`search_tsv @@ websearch_to_tsquery('simple',${param(query.q)})`);
    else { const pattern = param(`%${escapeLike(query.q)}%`); clauses.push(`(summary ILIKE ${pattern} ESCAPE '\\' OR body ILIKE ${pattern} ESCAPE '\\')`); }
  }
  if (query.cursor) {
    if (!(await db.query("SELECT 1 FROM memories WHERE id=$1 AND agent_id=$2", [query.cursor, agentId])).rowCount) throw new MemoryError(400, "bad_request", "Unknown cursor");
    clauses.push(`(created_at,id)<(SELECT created_at,id FROM memories WHERE id=${param(query.cursor)} AND agent_id=$1)`);
  }
  const limit = param(query.limit);
  const r = await db.query(`SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ${limit}`, params);
  const data = r.rows.map(memoryFrom);
  return { data, page: { next_cursor: data.length === query.limit ? data.at(-1)!.memory_id : null } };
}

export async function listMemoryEvents(db: Db, agentId: string, query: { cursor?: string; limit: number }) {
  if (query.cursor && !(await db.query("SELECT 1 FROM memory_events WHERE id=$1 AND agent_id=$2", [query.cursor, agentId])).rowCount) throw new MemoryError(400, "bad_request", "Unknown cursor");
  const r = await db.query("SELECT * FROM memory_events WHERE agent_id=$1 AND ($2::text IS NULL OR (created_at,id)<(SELECT created_at,id FROM memory_events WHERE id=$2 AND agent_id=$1)) ORDER BY created_at DESC,id DESC LIMIT $3", [agentId, query.cursor ?? null, query.limit]);
  const data = r.rows.map(eventFrom);
  return { data, page: { next_cursor: data.length === query.limit ? data.at(-1)!.event_id : null } };
}

/** PRD §3.3 transition table. The caller owns the transaction and must hold lockAgentMemory(). */
export async function setActive(client: PoolClient, p: Principal, agentId: string, memoryId: string, active: boolean) {
  const current = (await client.query("SELECT * FROM memories WHERE id=$1 AND agent_id=$2 FOR UPDATE", [memoryId, agentId])).rows[0];
  if (!current) throw new MemoryError(404, "not_found", "Memory not found");
  if (current.active === active) return memoryFrom(current);
  if (!active) {
    const r = await client.query("UPDATE memories SET active=false,archived_reason='manual' WHERE id=$1 RETURNING *", [memoryId]);
    await recordMemoryEvent(client, { agentId, type: "archived", principal: p, memoryIds: [memoryId] });
    return memoryFrom(r.rows[0]);
  }
  if (current.archived_reason === "superseded" || current.archived_reason === "consolidated") throw new MemoryError(409, "memory_not_reactivatable", `Memories archived as ${current.archived_reason} cannot be reactivated; supersede or write a new memory`);
  if (current.archived_reason === "personality_rollback" && p.type !== "owner") throw new MemoryError(403, "forbidden", "Only the owner can reactivate rolled-back influences");
  await assertCapacity(client, agentId, current.kind);
  const r = await client.query("UPDATE memories SET active=true,archived_reason=NULL WHERE id=$1 RETURNING *", [memoryId]);
  await recordMemoryEvent(client, { agentId, type: "reactivated", principal: p, memoryIds: [memoryId] });
  return memoryFrom(r.rows[0]);
}

/** PRD §3.5. The caller owns the transaction and must hold lockAgentMemory(). */
export async function consolidate(client: PoolClient, p: Principal, agentId: string, input: { summary: string; covered_until?: string }) {
  assertNoSecrets([input.summary]);
  // Bounds are compared in SQL to keep microsecond precision; clock_timestamp() is read after the lock is held.
  const bounds = (await client.query(
    `SELECT c.cu::text cu,c.cu>x.t future,(prev.covered_until IS NOT NULL AND c.cu<prev.covered_until) too_early,coalesce(prev.revision,0)+1 revision
     FROM (SELECT clock_timestamp() t) x CROSS JOIN LATERAL (SELECT coalesce($2::timestamptz,x.t) cu) c
     LEFT JOIN LATERAL (SELECT revision,covered_until FROM memory_summaries WHERE agent_id=$1 ORDER BY revision DESC LIMIT 1) prev ON true`,
    [agentId, input.covered_until ?? null]
  )).rows[0];
  if (bounds.future) throw new MemoryError(400, "bad_request", "covered_until must not be in the future");
  if (bounds.too_early) throw new MemoryError(400, "bad_request", "covered_until must not precede the previous consolidation");
  const sid = newId("msum");
  const archived = await client.query(
    "UPDATE memories SET active=false,archived_reason='consolidated',consolidated_into=$2 WHERE agent_id=$1 AND active AND kind<>$3 AND created_at<=$4::timestamptz RETURNING id",
    [agentId, sid, INFLUENCE, bounds.cu]
  );
  const summary = (await client.query(
    "INSERT INTO memory_summaries(id,agent_id,revision,summary,covered_until,archived_memory_count,created_by_type,created_by_id) VALUES($1,$2,$3,$4,$5::timestamptz,$6,$7,$8) RETURNING *",
    [sid, agentId, Number(bounds.revision), input.summary, bounds.cu, archived.rowCount ?? 0, p.type, p.id]
  )).rows[0];
  await recordMemoryEvent(client, { agentId, type: "consolidated", principal: p, memoryIds: archived.rows.map((x) => x.id), summaryId: sid });
  return { summary_id: sid, revision: summary.revision, covered_until: summary.covered_until, archived_memory_count: summary.archived_memory_count, created_at: summary.created_at };
}

/** PRD §3.6. Owner only; the caller owns the transaction and must hold lockAgentMemory(). */
export async function rollbackInfluences(client: PoolClient, p: Principal, agentId: string, input: { to_persona_revision: string; reverted_persona_revisions: string[]; target_created_at: string; reason?: string }) {
  assertNoSecrets([input.reason]);
  const r = await client.query(
    `UPDATE memories SET active=false,archived_reason='personality_rollback'
     WHERE agent_id=$1 AND kind=$2 AND active AND (persona_revision=ANY($3::text[]) OR (persona_revision IS NULL AND created_at>$4::timestamptz))
     RETURNING id`,
    [agentId, INFLUENCE, input.reverted_persona_revisions, input.target_created_at]
  );
  const ids = r.rows.map((x) => x.id as string);
  await recordMemoryEvent(client, { agentId, type: "rolled_back", principal: p, memoryIds: ids, reason: input.reason ?? null });
  await client.query("INSERT INTO inbox_events(id,owner_id,type,resource_kind,resource_id) VALUES($1,$2,'memory.rolled_back','agent',$3)", [newId("evt"), p.ownerId, agentId]);
  await client.query("INSERT INTO inbox_events(id,agent_id,type,resource_kind,resource_id) VALUES($1,$2,'memory.rolled_back','agent',$2)", [newId("evt"), agentId]);
  return { rolled_back_count: ids.length, memory_ids: ids, to_persona_revision: input.to_persona_revision };
}

/** PRD §3.5 selective startup. Without a summary, memory_summary is exactly the MVP output. */
export async function buildMemoryBootstrap(db: Db, agentId: string) {
  const counts = await activeCounts(db, agentId);
  const summary = (await db.query("SELECT * FROM memory_summaries WHERE agent_id=$1 ORDER BY revision DESC LIMIT 1", [agentId])).rows[0];
  if (!summary) {
    const rows = (await db.query("SELECT id,summary FROM memories WHERE agent_id=$1 AND active=true ORDER BY created_at DESC,id DESC LIMIT 10", [agentId])).rows;
    return {
      memory_summary: rows.length ? rows.map((x) => x.summary).join("\n") : null,
      memory: { summary_id: null, summary_revision: null, covered_until: null, recent_memory_ids: rows.map((x) => x.id), active_counts: counts }
    };
  }
  const recent = (await db.query("SELECT id,summary FROM memories WHERE agent_id=$1 AND active AND kind<>$2 AND created_at>$3 ORDER BY created_at DESC,id DESC LIMIT $4", [agentId, INFLUENCE, summary.covered_until, BOOTSTRAP_RECENT])).rows;
  const influences = (await db.query("SELECT id,summary FROM memories WHERE agent_id=$1 AND active AND kind=$2 ORDER BY created_at DESC,id DESC LIMIT $3", [agentId, INFLUENCE, BOOTSTRAP_RECENT])).rows;
  const lines = [summary.summary as string];
  if (recent.length) lines.push("", "Recent memories:", ...recent.map((x) => `- ${x.summary}`));
  if (influences.length) lines.push("", "Active personality influences:", ...influences.map((x) => `- ${x.summary}`));
  return {
    memory_summary: lines.join("\n"),
    memory: { summary_id: summary.id, summary_revision: summary.revision, covered_until: summary.covered_until, recent_memory_ids: [...recent, ...influences].map((x) => x.id), active_counts: counts }
  };
}
