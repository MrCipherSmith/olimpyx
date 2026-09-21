import crypto from "node:crypto";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { Pool, type PoolClient } from "pg";
import { installValidation, memoryEventsQuery, memoryListQuery } from "./validation.js";
import { createEmbeddingAdapter, ensureEmbeddingSchema, type EmbeddingStatus } from "./embeddings.js";
import { AuthRateLimiter, type RateLimitResult } from "./auth-guard.js";
import { recommendThreads } from "./recommendations.js";
import type { EndReason, Principal } from "./types.js";
import { ApiError } from "./errors.js";
import { effectiveLimits, enforceQuota, loadLimits, messageClassOf, recordQuotaEvent, type LimitsConfig } from "./limits.js";
import { agentUsage, ownerUsage } from "./usage.js";
import { detectSecret } from "./secret-scan.js";
import { MemoryError, buildMemoryBootstrap, computeMemoryFingerprint, consolidate, getMemory, listMemories, listMemoryEvents, lockAgentMemory, rollbackInfluences, setActive, writeMemory } from "./memory.js";
import { cityGuide, registerCityGuide } from "./city-guide.js";

const scrypt = promisify(crypto.scrypt);
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const token = () => crypto.randomBytes(32).toString("base64url");
const hashToken = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const cursorOf = (sequence: string | number) => Buffer.from(String(sequence)).toString("base64url");
const cursorFrom = (cursor?: string) => cursor ? Number(Buffer.from(cursor, "base64url").toString()) || 0 : 0;
const boundedLimit = (input: unknown) => Math.min(100, Math.max(1, Number(input) || 50));

async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}
async function verifyPassword(password: string, encoded: string) {
  const [salt, expected] = encoded.split(":");
  if (!salt || !expected) return false;
  const derived = await scrypt(password, salt, 64) as Buffer;
  return crypto.timingSafeEqual(derived, Buffer.from(expected, "hex"));
}

export async function migrate(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS owners (id text PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL, display_name text NOT NULL, restricted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS auth_tokens (token_hash text PRIMARY KEY, actor_type text NOT NULL, actor_id text NOT NULL, token_type text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz);
    CREATE TABLE IF NOT EXISTS enrollment_tokens (token_hash text PRIMARY KEY, owner_id text NOT NULL REFERENCES owners(id), expires_at timestamptz NOT NULL, used_at timestamptz);
    CREATE TABLE IF NOT EXISTS agents (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES owners(id), installation_id text NOT NULL, name text NOT NULL, role text NOT NULL, bio text NOT NULL DEFAULT '', interests jsonb NOT NULL DEFAULT '[]', capabilities jsonb NOT NULL DEFAULT '[]', profile_revision integer NOT NULL DEFAULT 1, restricted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id, installation_id));
    CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, agent_id text NOT NULL REFERENCES agents(id), token_hash text UNIQUE NOT NULL, host jsonb NOT NULL, persona_revision integer NOT NULL, expires_at timestamptz NOT NULL, last_heartbeat_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS rooms (id text PRIMARY KEY, slug text UNIQUE NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '', creator_type text NOT NULL, creator_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS messages (id text PRIMARY KEY, room_id text NOT NULL REFERENCES rooms(id), sender_type text NOT NULL, sender_id text NOT NULL, sender_name text NOT NULL, recipient_agent_id text REFERENCES agents(id), reply_to_message_id text REFERENCES messages(id), body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS root_message_id text REFERENCES messages(id);
    CREATE INDEX IF NOT EXISTS idx_messages_root ON messages(room_id, root_message_id, created_at);
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS idempotency_actor text;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS idempotency_key text;
    CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_unique ON messages(idempotency_actor,idempotency_key) WHERE idempotency_key IS NOT NULL;
    -- W1 (issue #36): explicit room membership, so a message without a recipient can fan out to "the room" instead of nobody.
    -- Auto-joined on an agent's first post to a room (idempotent), joinable/leavable explicitly via POST/DELETE .../members.
    CREATE TABLE IF NOT EXISTS room_members (room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE, joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(room_id, agent_id));
    CREATE INDEX IF NOT EXISTS idx_room_members_agent ON room_members(agent_id);
    CREATE TABLE IF NOT EXISTS inbox_events (sequence bigserial PRIMARY KEY, id text UNIQUE NOT NULL, owner_id text, agent_id text, type text NOT NULL, resource_kind text NOT NULL, resource_id text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS inbox_checkpoints (actor_type text NOT NULL, actor_id text NOT NULL, sequence bigint NOT NULL, saved_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_type,actor_id));
    CREATE TABLE IF NOT EXISTS idempotency_keys (actor_key text NOT NULL, key text NOT NULL, body_hash text NOT NULL, status integer NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_key,key));
    CREATE TABLE IF NOT EXISTS knowledge_cards (id text PRIMARY KEY, author_agent_id text NOT NULL REFERENCES agents(id), latest_version_id text, challenge_card_id text REFERENCES knowledge_cards(id), challenge_version_id text, created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE knowledge_cards ADD COLUMN IF NOT EXISTS public boolean NOT NULL DEFAULT false;
    ALTER TABLE knowledge_cards ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS knowledge_cards_public_created_at ON knowledge_cards(public,created_at DESC) WHERE public=true;
    CREATE INDEX IF NOT EXISTS idx_knowledge_cards_pub_arch ON knowledge_cards(public, archived, created_at DESC);
    CREATE TABLE IF NOT EXISTS knowledge_versions (id text PRIMARY KEY, card_id text NOT NULL REFERENCES knowledge_cards(id), version integer NOT NULL, topic text NOT NULL, summary text NOT NULL, body text NOT NULL, sources jsonb NOT NULL DEFAULT '[]', refs jsonb NOT NULL DEFAULT '[]', author_agent_id text NOT NULL REFERENCES agents(id), confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(card_id,version));
    ALTER TABLE knowledge_versions ADD COLUMN IF NOT EXISTS idempotency_key text;
    ALTER TABLE knowledge_versions ADD COLUMN IF NOT EXISTS idempotency_body_hash text;
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_versions_idempotency_unique ON knowledge_versions(author_agent_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS knowledge_reviews (id text PRIMARY KEY, version_id text NOT NULL REFERENCES knowledge_versions(id), reviewer_agent_id text NOT NULL REFERENCES agents(id), verdict text NOT NULL, explanation text NOT NULL, evidence jsonb NOT NULL DEFAULT '[]', revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(version_id,reviewer_agent_id));
    CREATE INDEX IF NOT EXISTS idx_knowledge_reviews_version_verdict ON knowledge_reviews(version_id, verdict);
    CREATE TABLE IF NOT EXISTS knowledge_review_revisions (review_id text NOT NULL, revision integer NOT NULL, verdict text NOT NULL, explanation text NOT NULL, evidence jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL, archived_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(review_id,revision));
    CREATE TABLE IF NOT EXISTS memories (id text PRIMARY KEY, agent_id text NOT NULL REFERENCES agents(id), kind text NOT NULL, summary text NOT NULL, body text NOT NULL, active boolean NOT NULL, source_ref jsonb, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS tasks (id text PRIMARY KEY, room_id text NOT NULL REFERENCES rooms(id), creator_type text NOT NULL, creator_id text NOT NULL, creator_name text NOT NULL, assigned_agent_id text NOT NULL REFERENCES agents(id), title text NOT NULL, description text NOT NULL, status text NOT NULL DEFAULT 'proposed', result text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS reports (id text PRIMARY KEY, reporter_type text NOT NULL, reporter_id text NOT NULL, target_kind text NOT NULL, target_id text NOT NULL, category text NOT NULL, explanation text NOT NULL, status text NOT NULL DEFAULT 'escalated', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS incidents (id text PRIMARY KEY, report_id text NOT NULL REFERENCES reports(id), owner_id text, agent_id text, status text NOT NULL DEFAULT 'owner_escalation', action text NOT NULL DEFAULT 'none', resolution text NOT NULL DEFAULT 'Automated moderation unavailable; human review required', revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE owners ADD COLUMN IF NOT EXISTS restricted_until timestamptz;
    ALTER TABLE owners ADD COLUMN IF NOT EXISTS restriction_kind text;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS restricted_until timestamptz;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS restriction_kind text;
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS sanction_kind text NOT NULL DEFAULT 'none';
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS sanction_expires_at timestamptz;
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS appeal_status text NOT NULL DEFAULT 'none';
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS appeal_reason text;
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS appeal_evidence jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS appeal_submitted_at timestamptz;
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS appeal_resolved_at timestamptz;
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS appeal_resolution text;
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;
    -- W3 (issue #36): a room without a goal degenerates into an open-ended chat (roomyx's own
    -- diagnosis of the same failure mode). All three are optional so existing rooms, and rooms
    -- created without one, stay fully valid; goal_status is creator-set only, no convergence
    -- machinery (no participant voting/quorum) since that needs a dispatcher we don't have.
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS goal text;
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS success_criteria jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE rooms ADD COLUMN IF NOT EXISTS goal_status text NOT NULL DEFAULT 'open';
    ALTER TABLE rooms DROP CONSTRAINT IF EXISTS chk_rooms_goal_status;
    ALTER TABLE rooms ADD CONSTRAINT chk_rooms_goal_status
      CHECK (goal_status IN ('open', 'reached', 'abandoned'));
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS category text;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
    CREATE TABLE IF NOT EXISTS agent_subscriptions (
      agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tag text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(agent_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_subscriptions_tag ON agent_subscriptions(tag);
    CREATE INDEX IF NOT EXISTS idx_agent_subscriptions_agent ON agent_subscriptions(agent_id);
    -- Per-agent "where am I" indicator (PRD city-inhabitant §6). One row per agent,
    -- latest-wins, refreshed by POST /v1/sessions/me/activity. Exposed in
    -- /v1/agents as "current_activity" only while the agent has a live session
    -- (presence predicate aligns with the 90-second heartbeat window).
    CREATE TABLE IF NOT EXISTS agent_activities (
      agent_id text PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('room','knowledge','lobby','inbox','offline')),
      location_ref text,
      note text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_activities_updated ON agent_activities(updated_at DESC);
    ALTER TABLE messages DROP CONSTRAINT IF EXISTS chk_messages_category;
    ALTER TABLE messages ADD CONSTRAINT chk_messages_category 
      CHECK (category IS NULL OR category IN ('question', 'discussion', 'task_proposal', 'review_request'));
    ALTER TABLE messages DROP CONSTRAINT IF EXISTS chk_messages_status;
    ALTER TABLE messages ADD CONSTRAINT chk_messages_status 
      CHECK (status IN ('open', 'resolved', 'closed'));
    ALTER TABLE messages DROP CONSTRAINT IF EXISTS chk_messages_root_forum;
    ALTER TABLE messages ADD CONSTRAINT chk_messages_root_forum 
      CHECK (reply_to_message_id IS NULL OR (category IS NULL AND resolved_at IS NULL));
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence text;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS persona_revision text;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS supersedes_id text REFERENCES memories(id);
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_by text REFERENCES memories(id);
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS consolidated_into text;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS fingerprint text;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS archived_reason text CHECK (archived_reason IN ('superseded','consolidated','personality_rollback','manual'));
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(summary,'') || ' ' || coalesce(body,''))) STORED;
    UPDATE memories SET archived_reason='manual' WHERE active=false AND archived_reason IS NULL;
    UPDATE memories SET archived_reason=NULL WHERE active AND archived_reason IS NOT NULL;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_memories_archived_reason' AND conrelid='memories'::regclass) THEN
        ALTER TABLE memories ADD CONSTRAINT chk_memories_archived_reason CHECK (active = (archived_reason IS NULL));
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS memory_summaries (id text PRIMARY KEY, agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE, revision integer NOT NULL, summary text NOT NULL, covered_until timestamptz NOT NULL, archived_memory_count integer NOT NULL, created_by_type text NOT NULL, created_by_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(agent_id, revision));
    CREATE TABLE IF NOT EXISTS memory_events (id text PRIMARY KEY, agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE, type text NOT NULL, actor_type text NOT NULL, actor_id text NOT NULL, memory_ids jsonb NOT NULL DEFAULT '[]'::jsonb, summary_id text, reason text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS idx_memories_agent_active_kind ON memories(agent_id, active, kind, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_fingerprint ON memories(agent_id, fingerprint, created_at DESC) WHERE active;
    CREATE INDEX IF NOT EXISTS idx_memories_influence_rev ON memories(agent_id, persona_revision) WHERE kind='personality_influence' AND active;
    CREATE INDEX IF NOT EXISTS idx_memories_agent_created ON memories(agent_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING gin(tags);
    CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING gin(search_tsv);
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_agent ON memory_summaries(agent_id, revision DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_events_agent ON memory_events(agent_id, created_at DESC, id DESC);
    DELETE FROM idempotency_keys WHERE response::text ~ '"(access_token|agent_token|session_token|enrollment_token)"';
    -- Q-016 / D-045: revoke is a real state; heuristic one-time backfill for agents revoked (restricted without a kind) before the column existed.
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='agents' AND column_name='revoked_at') THEN
        ALTER TABLE agents ADD COLUMN revoked_at timestamptz;
        UPDATE agents SET revoked_at = now() WHERE restricted AND restriction_kind IS NULL AND restricted_until IS NULL AND revoked_at IS NULL;
      END IF;
    END $$;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS end_reason text;
    ALTER TABLE inbox_events ADD COLUMN IF NOT EXISTS payload jsonb;
    CREATE TABLE IF NOT EXISTS quota_events (id bigserial PRIMARY KEY, action text NOT NULL, actor_type text NOT NULL, actor_id text NOT NULL, owner_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS idx_quota_events_owner_action_created ON quota_events(owner_id, action, created_at);
    CREATE INDEX IF NOT EXISTS idx_quota_events_actor_action_created ON quota_events(actor_type, actor_id, action, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent_active ON sessions(agent_id, created_at) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_rooms_creator_created ON rooms(creator_type, creator_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_open ON tasks(assigned_agent_id) WHERE status NOT IN ('completed','failed','cancelled');
    CREATE INDEX IF NOT EXISTS idx_tasks_creator_created ON tasks(creator_type, creator_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_cards_author_created ON knowledge_cards(author_agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_versions_author_created ON knowledge_versions(author_agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_reviews_reviewer_created ON knowledge_reviews(reviewer_agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_reporter_created ON reports(reporter_type, reporter_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_owner_unused ON enrollment_tokens(owner_id) WHERE used_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
  `);

  const indexes = [
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_restricted_expiry ON agents(restricted, restricted_until) WHERE restricted = true",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_owners_restricted_expiry ON owners(restricted, restricted_until) WHERE restricted = true",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_incidents_appeal_pending ON incidents(appeal_status) WHERE appeal_status = 'pending'",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_incidents_owner_created ON incidents(owner_id, created_at DESC, id DESC)",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_forum_discovery ON messages(status, created_at DESC, id DESC) WHERE root_message_id IS NULL AND category IS NOT NULL",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_forum_category ON messages(category, status, created_at DESC) WHERE root_message_id IS NULL AND category IS NOT NULL",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_forum_tags ON messages USING gin(tags) WHERE root_message_id IS NULL AND category IS NOT NULL",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_forum_room ON messages(room_id, status, created_at DESC) WHERE root_message_id IS NULL AND category IS NOT NULL",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_root_sender ON messages(root_message_id, sender_type, sender_id) WHERE root_message_id IS NOT NULL",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_sender_created ON messages(sender_type, sender_id, created_at DESC)",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inbox_events_occurred ON inbox_events(occurred_at)",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inbox_events_agent_seq ON inbox_events(agent_id, sequence) WHERE agent_id IS NOT NULL",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inbox_events_owner_seq ON inbox_events(owner_id, sequence) WHERE owner_id IS NOT NULL",
    // Retention keeps each agent's latest session: the per-row "latest" probe needs this index (Q-016).
    // Superseded by idx_sessions_agent_heartbeat_id below, which adds an `id DESC` tie-break so the
    // "latest" subquery in retention.ts is deterministic when two sessions share last_heartbeat_at.
    "DROP INDEX CONCURRENTLY IF EXISTS idx_sessions_agent_heartbeat",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_agent_heartbeat_id ON sessions(agent_id, last_heartbeat_at DESC, id DESC)"
  ];
  for (const idx of indexes) {
    try {
      await pool.query(idx);
    } catch {
      await pool.query(idx.replace("CONCURRENTLY ", ""));
    }
  }
  // Influences deduplicated within the last 24h must carry the per-revision fingerprint introduced with Q-008.
  for (const row of (await pool.query("SELECT id,kind,summary,persona_revision,fingerprint FROM memories WHERE kind='personality_influence' AND active AND created_at>now()-interval '24 hours'")).rows) {
    const fingerprint = computeMemoryFingerprint(row.kind, row.summary, row.persona_revision);
    if (fingerprint !== row.fingerprint) await pool.query("UPDATE memories SET fingerprint=$1 WHERE id=$2", [fingerprint, row.id]);
  }
  await ensureEmbeddingSchema(pool);
  await pool.end();
}

export type ReviewVerdictRow = {
  verdict: string;
  reviewer_owner_id: string;
  author_owner_id: string;
  reviewer_agent_restricted?: boolean;
  reviewer_owner_restricted?: boolean;
};

export function isRestricted(entity: { restricted: boolean; restricted_until?: string | Date | null }): boolean {
  if (!entity.restricted) return false;
  if (!entity.restricted_until) return true;
  return new Date(entity.restricted_until).getTime() > Date.now();
}

export function isRestrictedOwnerExemptPath(method: string, path: string): boolean {
  const cleanPath = path.split("?")[0];
  if (method === "GET") {
    return cleanPath === "/v1/owners/me" ||
           cleanPath === "/v1/owners/me/escalations" ||
           cleanPath === "/v1/owners/me/incidents" ||
           cleanPath === "/v1/limits";
  }
  if (method === "POST") {
    return /^\/v1\/owners\/me\/incidents\/[^/]+\/appeal$/.test(cleanPath);
  }
  return false;
}

export function evaluateMaliciousReportPenalty(priorDismissedMaliciousCount: number): {
  penalty: "warning" | "temporary_restriction";
  durationSec?: number;
} {
  if (priorDismissedMaliciousCount === 0) {
    return { penalty: "warning" };
  }
  return { penalty: "temporary_restriction", durationSec: 86400 }; // 24 hours
}

export function isDuplicateOpenReport(
  existingReports: Array<{ target_kind: string; target_id: string; incident_status: string }>,
  targetKind: string,
  targetId: string
): boolean {
  return existingReports.some(
    (r) => r.target_kind === targetKind && r.target_id === targetId && r.incident_status !== "resolved"
  );
}

export function isReportQuotaExceeded(recentReportsCount: number, limitPerHour: number = 10): boolean {
  return recentReportsCount >= limitPerHour;
}

export function evaluateReviewQuorum(
  reviews: ReviewVerdictRow[],
  threshold: number,
  confirmedAt?: string | Date | null
) {
  const raw = { confirm: 0, refute: 0, comment: 0 };
  const ownerVerdicts = new Map<string, Set<string>>();

  for (const r of reviews) {
    if (r.verdict === "confirm") raw.confirm++;
    else if (r.verdict === "refute") raw.refute++;
    else if (r.verdict === "comment") raw.comment++;

    // Anti-Sybil Owner Independence Rule:
    // Exclude same-owner reviews (author self-reviews or reviews from agents under author's owner)
    if (r.reviewer_owner_id === r.author_owner_id) continue;
    // Exclude restricted agents and restricted owners
    if (r.reviewer_agent_restricted || r.reviewer_owner_restricted) continue;

    if (!ownerVerdicts.has(r.reviewer_owner_id)) {
      ownerVerdicts.set(r.reviewer_owner_id, new Set());
    }
    ownerVerdicts.get(r.reviewer_owner_id)!.add(r.verdict);
  }

  let independentConfirms = 0;
  let independentRefutes = 0;

  for (const [, verdicts] of ownerVerdicts.entries()) {
    // Contested owner stance (M3):
    // If any agent of that owner submitted verdict = 'refute', owner counts as 1 refute and 0 confirms
    if (verdicts.has("refute")) {
      independentRefutes++;
    } else if (verdicts.has("confirm")) {
      // At least one confirm and no refute
      independentConfirms++;
    }
    // Note: comments are discussion-only (M4) and do not contribute to independent votes
  }

  let status: "unconfirmed" | "confirmed" | "refuted" = "unconfirmed";
  if (independentRefutes >= threshold && independentRefutes > independentConfirms) {
    status = "refuted";
  } else if (confirmedAt != null || independentConfirms >= threshold) {
    status = "confirmed";
  }

  return {
    raw,
    independent: {
      confirm: independentConfirms,
      refute: independentRefutes
    },
    threshold,
    status,
    quorum: {
      threshold,
      independent_confirms: independentConfirms,
      independent_refutes: independentRefutes,
      reached: status === "confirmed",
      confirms_needed: Math.max(0, threshold - independentConfirms)
    }
  };
}

export type { Principal } from "./types.js";
export type OlimpyxApp = FastifyInstance & { pg: Pool };

export async function createApp(options: { databaseUrl?: string; env?: Record<string, string | undefined> } = {}): Promise<OlimpyxApp> {
  const limits: LimitsConfig = loadLimits(options.env ?? process.env);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
  const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.body.password", "req.body.enrollment_token"] }, bodyLimit: 262144 }) as unknown as OlimpyxApp;
  // W3 (issue #36): validation.ts's global preValidation hook (installed next) re-parses
  // POST /v1/rooms's body against a schema that doesn't know about goal/success_criteria and
  // strips unrecognized keys — that's out of scope here (apps/server/src/validation.ts is not
  // touched by this change). Registering this hook first means it runs before that one, so it
  // can stash the original values for the room-creation handler to read and validate itself,
  // the same way this file already hand-validates message category/tags inline.
  app.addHook("preValidation", async (req) => {
    if (req.method === "POST" && req.url.split("?")[0] === "/v1/rooms") {
      const b = req.body as any;
      (req as any).roomGoalInput = { goal: b?.goal, success_criteria: b?.success_criteria };
    }
  });
  installValidation(app);
  registerCityGuide(app);
  app.decorate("pg", new Pool({ connectionString: databaseUrl }));
  const idempotencyPool=new Pool({connectionString:databaseUrl,max:50});
  const embeddings=createEmbeddingAdapter();
  const authRateLimiter=new AuthRateLimiter();
  let embeddingCache:{at:number,value:EmbeddingStatus}={at:0,value:{status:"unavailable"}};
  async function embeddingStatus(){if(Date.now()-embeddingCache.at>30000)embeddingCache={at:Date.now(),value:await embeddings.status()};return embeddingCache.value}
  async function indexVersion(versionId:string,text:string){const vector=await embeddings.embed(text);if(!vector)return;await app.pg.query("INSERT INTO knowledge_embeddings(version_id,embedding,model) VALUES($1,$2,$3) ON CONFLICT(version_id) DO UPDATE SET embedding=excluded.embedding,model=excluded.model,created_at=now()",[versionId,`[${vector.join(",")}]`,process.env.EMBEDDING_MODEL??"sentence-transformers/all-MiniLM-L6-v2"]);embeddingCache={at:Date.now(),value:{status:"available",provider:new URL(process.env.EMBEDDING_BASE_URL!).origin,dimension:vector.length}}}
  app.addHook("onClose", async () => { await app.pg.end(); await idempotencyPool.end(); });
  app.addHook("onSend", async (_request, reply) => { reply.header("X-Request-Id", reply.request.id); });
  if (!process.env.MODERATOR_TOKEN) {
    app.log.warn("MODERATOR_TOKEN is not configured; moderator endpoints will reject all calls");
  }

  const fail = (reply: any, status: number, code: string, message: string, extra?: Record<string, any>) => reply.code(status).send({ error: { code, message, request_id: reply.request.id, details: [], ...extra } });
  const enforceAuthLimit=(reply:any,result:RateLimitResult)=>{if(result.allowed)return false;reply.header("Retry-After",String(result.retryAfterSeconds));fail(reply,429,"rate_limited","Too many authentication attempts; retry later");return true};
  const RESTRICTED_SQL = (alias: string) => `(${alias}.restricted = true AND (${alias}.restricted_until IS NULL OR ${alias}.restricted_until > now()))`;
  const endedSession: Record<string, [string, string]> = {
    owner_stop: ["session_stopped", "Session was stopped by the owner"],
    superseded: ["session_superseded", "Session was superseded by a newer session"],
    revoked: ["agent_revoked", "Agent has been revoked"]
  };
  /**
   * Resolution order (PRD §3.2): no row → 401 unauthorized; credential class → 403 forbidden; agent revoked → 401 agent_revoked;
   * restricted → 403 restricted; session ended → typed 401 by end_reason; expired or stale heartbeat → 401 session_expired.
   */
  async function principal(req: FastifyRequest, reply: any, allowed: Array<Principal["tokenType"]> = ["owner", "session"]): Promise<Principal | null> {
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!raw) { fail(reply, 401, "unauthorized", "Authentication required"); return null; }
    const h = hashToken(raw);
    // Not filtered on the token's own revoked_at: a revoked agent's token must still resolve to agent_revoked.
    const t = (await app.pg.query(`SELECT t.*, a.revoked_at agent_revoked_at FROM auth_tokens t LEFT JOIN agents a ON t.actor_type='agent' AND a.id=t.actor_id WHERE t.token_hash=$1 AND t.expires_at>now()`, [h])).rows[0];
    if (t && (t.revoked_at === null || t.agent_revoked_at)) {
      if (!allowed.includes(t.token_type)) { fail(reply, 403, "forbidden", "Credential class is not allowed"); return null; }
      if (t.actor_type === "owner") {
        const o = (await app.pg.query(`SELECT *, ${RESTRICTED_SQL("owners")} AS is_restricted FROM owners WHERE id=$1`, [t.actor_id])).rows[0];
        if (!o) { fail(reply, 401, "unauthorized", "Invalid credential"); return null; }
        if (o.is_restricted && !isRestrictedOwnerExemptPath(req.method, req.url)) { fail(reply, 403, "restricted", "Network access restricted"); return null; }
        return { type: "owner", id: o.id, ownerId: o.id, name: o.display_name, tokenType: t.token_type };
      }
      if (t.actor_type === "agent") {
        if (t.agent_revoked_at) { fail(reply, 401, "agent_revoked", "Agent has been revoked"); return null; }
        const a = (await app.pg.query(`SELECT a.*, ${RESTRICTED_SQL("a")} AS agent_restricted, ${RESTRICTED_SQL("o")} AS owner_restricted FROM agents a JOIN owners o ON o.id=a.owner_id WHERE a.id=$1`, [t.actor_id])).rows[0];
        if (!a || a.agent_restricted || a.owner_restricted) { fail(reply, 403, "restricted", "Network access restricted"); return null; }
        return { type: "agent", id: a.id, ownerId: a.owner_id, name: a.name, tokenType: "agent" };
      }
    }
    const s = (await app.pg.query(`SELECT s.id session_id,s.agent_id,s.ended_at,s.end_reason,(s.expires_at>now() AND s.last_heartbeat_at>now()-interval '90 seconds') live,a.owner_id,a.name,a.revoked_at, ${RESTRICTED_SQL("a")} AS agent_restricted, ${RESTRICTED_SQL("o")} AS owner_restricted FROM sessions s JOIN agents a ON a.id=s.agent_id JOIN owners o ON o.id=a.owner_id WHERE s.token_hash=$1`, [h])).rows[0];
    if (!s) return fail(reply, 401, "unauthorized", "Invalid or expired credential"), null;
    if (!allowed.includes("session")) { fail(reply, 403, "forbidden", "Credential class is not allowed"); return null; }
    if (s.revoked_at) { fail(reply, 401, "agent_revoked", "Agent has been revoked"); return null; }
    if (s.agent_restricted || s.owner_restricted) { fail(reply, 403, "restricted", "Network access restricted"); return null; }
    if (s.ended_at) { const [code, message] = endedSession[s.end_reason] ?? ["session_expired", "Session has ended"]; fail(reply, 401, code, message); return null; }
    if (!s.live) { fail(reply, 401, "session_expired", "Session expired"); return null; }
    return { type: "agent", id: s.agent_id, ownerId: s.owner_id, name: s.name, tokenType: "session", sessionId: s.session_id };
  }
  function isModerator(req:FastifyRequest,reply:any){const configured=process.env.MODERATOR_TOKEN,raw=req.headers.authorization?.replace(/^Bearer\s+/i,"");if(!configured||!raw||!crypto.timingSafeEqual(Buffer.from(hashToken(configured)),Buffer.from(hashToken(raw)))){fail(reply,401,"unauthorized","Moderator authentication required");return false}return true}
  const bodyHash = (body: unknown) => crypto.createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
  /** `work` may run its queries on `client` (the idempotency transaction) so its effects and the stored response commit atomically. */
  async function idem(req: FastifyRequest, reply: any, actorKey: string, work: (client: PoolClient) => Promise<{ status: number; data: unknown }>) {
    const key = req.headers["idempotency-key"] as string | undefined;
    if (!key || key.length > 128) return fail(reply, 400, "idempotency_key_required", "Valid Idempotency-Key required");
    const hash = bodyHash({ method: req.method, path: req.url.split("?")[0], body: req.body });
    const lock = await idempotencyPool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [actorKey, key]);
      const old = await lock.query("SELECT * FROM idempotency_keys WHERE actor_key=$1 AND key=$2", [actorKey, key]);
      if (old.rowCount) {
        await lock.query("COMMIT");
        if (old.rows[0].body_hash !== hash) return fail(reply, 409, "idempotency_conflict", "Key was used with a different body");
        return reply.code(old.rows[0].status).send(old.rows[0].response);
      }
      const result = await work(lock);
      if (reply.sent) { await lock.query("ROLLBACK"); return; }
      const response = { data: result.data };
      const serialized = JSON.stringify(response);
      const credentialBearing = /"(?:access_token|agent_token|session_token|enrollment_token)"\s*:/.test(serialized);
      if (!credentialBearing) await lock.query("INSERT INTO idempotency_keys(actor_key,key,body_hash,status,response) VALUES($1,$2,$3,$4,$5)", [actorKey, key, hash, result.status, response]);
      await lock.query("COMMIT");
      return reply.code(result.status).send(response);
    } catch (error) {
      await lock.query("ROLLBACK");
      throw error;
    } finally { lock.release(); }
  }
  const actor = (p: Principal) => ({ actor_type: p.type, actor_id: p.id, display_name: p.name });
  // W3 (issue #36): a room's goal, exposed identically everywhere a room is (GET /v1/rooms,
  // GET /v1/rooms/:roomId, bootstrap's active_rooms) — a room without one still reports
  // goal: null, success_criteria: [], goal_status: "open" rather than omitting the fields.
  const successCriteriaFrom = (x: any) => Array.isArray(x.success_criteria)
    ? x.success_criteria
    : (typeof x.success_criteria === "string" ? JSON.parse(x.success_criteria) : (x.success_criteria ?? []));
  const roomGoalFields = (x: any) => ({ goal: x.goal ?? null, success_criteria: successCriteriaFrom(x), goal_status: x.goal_status ?? "open" });
  // W3 (issue #36): hand-validated the same way this file already validates message category/tags
  // inline (see POST /v1/rooms/:roomId/messages) rather than through validation.ts. ROOM_TEXT_MAX
  // matches the limit validation.ts already applies to a room's own `title` — a goal is "one
  // sentence" too, the same kind of field on the same row.
  const ROOM_TEXT_MAX = 120;
  const ROOM_GOAL_STATUSES = ["open", "reached", "abandoned"];
  function goalError(v: unknown): string | null {
    if (v === undefined) return null;
    if (typeof v !== "string" || v.trim().length < 1 || v.trim().length > ROOM_TEXT_MAX) {
      return `goal must be a string of 1-${ROOM_TEXT_MAX} characters`;
    }
    return null;
  }
  function criteriaError(v: unknown): string | null {
    if (v === undefined) return null;
    if (!Array.isArray(v) || v.length > 30) return "success_criteria must be an array of at most 30 strings";
    for (const item of v) {
      if (typeof item !== "string" || item.trim().length < 1 || item.trim().length > ROOM_TEXT_MAX) {
        return `each success_criteria item must be a non-empty string of at most ${ROOM_TEXT_MAX} characters`;
      }
    }
    return null;
  }
  type Db = Pool | PoolClient;
  /** Typed agent signal (stop, revoke, restriction) with structured `payload`, exposed as `data` on inbox events. */
  async function agentEvent(db: Db, agentId: string, type: string, payload: Record<string, unknown>) {
    await db.query("INSERT INTO inbox_events(id,agent_id,type,resource_kind,resource_id,payload) VALUES($1,$2,$3,'agent',$2,$4)", [id("evt"), agentId, type, JSON.stringify(payload)]);
  }
  /**
   * Ends every open session of the agent. Must run inside the caller's transaction: it takes the same
   * `sessions:<agentId>` xact lock as POST /v1/sessions (lock order idem → sessions), so a session being
   * created concurrently either commits first and is ended here, or starts after this transaction commits.
   */
  async function endAgentSessions(db: PoolClient, agentId: string, reason: EndReason): Promise<string[]> {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`sessions:${agentId}`]);
    return (await db.query("UPDATE sessions SET ended_at=now(), end_reason=$2 WHERE agent_id=$1 AND ended_at IS NULL RETURNING id", [agentId, reason])).rows.map(x => x.id);
  }
  function assertNoSecret(values: unknown[]) {
    const kind = detectSecret(values);
    if (kind) throw new ApiError(422, "secret_detected", `Content refused: detected ${kind}. Remove the secret before sending.`, { kind });
  }
  const effective = effectiveLimits(limits);
  // Activity row is "current" only while it's fresh AND the agent is online, so the city UI
  // never shows a ghost navigation link for a session that has already timed out.
  const ACTIVITY_TTL_SQL = `now() - interval '90 seconds'`;
  const activityFrom = (r: any) => {
    if (!r.activity_kind) return null;
    if (!r.activity_updated_at) return null;
    if (new Date(r.activity_updated_at).getTime() < Date.now() - 90_000) return null;
    if (!r.online) return null;
    return { kind: r.activity_kind, location_ref: r.activity_location_ref ?? null, note: r.activity_note ?? "", updated_at: r.activity_updated_at };
  };
  const profileFrom = (r: any) => { const last= r.last_seen_at ? new Date(r.last_seen_at).getTime() : null; const inactive=last!==null&&last<Date.now()-14*86400000; return { agent_id: r.id, name: r.name, role: r.role, bio: r.bio, interests: r.interests, capabilities: r.capabilities, created_at: r.created_at, presence: r.online ? "online" : "offline", last_seen_at: r.last_seen_at, current_activity: activityFrom(r), inactive_warning: inactive, archived: inactive, profile_revision: r.profile_revision }; };
  const profileSql = `SELECT a.*, EXISTS(SELECT 1 FROM sessions s WHERE s.agent_id=a.id AND s.ended_at IS NULL AND s.expires_at>now() AND s.last_heartbeat_at>now()-interval '90 seconds') online,(SELECT max(last_heartbeat_at) FROM sessions s WHERE s.agent_id=a.id) last_seen_at,act.kind activity_kind,act.location_ref activity_location_ref,act.note activity_note,act.updated_at activity_updated_at FROM agents a LEFT JOIN agent_activities act ON act.agent_id=a.id`;
  async function bootstrapFor(agentId:string) {
    const agent=profileFrom((await app.pg.query(`${profileSql} WHERE a.id=$1`,[agentId])).rows[0]);
    const checkpoint=Number((await app.pg.query("SELECT coalesce((SELECT sequence FROM inbox_checkpoints WHERE actor_type='agent' AND actor_id=$1),0) n",[agentId])).rows[0].n);
    const pending=await app.pg.query("SELECT type,count(*) n FROM inbox_events WHERE agent_id=$1 AND sequence>$2 GROUP BY type",[agentId,checkpoint]);
    // W2 (issue #36): task (task.changed/task.cancelled), forum.thread and knowledge events were
    // never bucketed here; without this an agent's bootstrap still reports zero for everything
    // but messages and moderation, even with unread task/forum/knowledge events waiting.
    const counts={messages:0,moderation:0,tasks:0,forum:0,knowledge:0,rooms:0}; for(const x of pending.rows){if(x.type==="message.created")counts.messages+=Number(x.n);if(x.type==="moderation.updated")counts.moderation+=Number(x.n);if(x.type==="task.changed"||x.type==="task.cancelled")counts.tasks+=Number(x.n);if(x.type==="forum.thread")counts.forum+=Number(x.n);if(x.type==="knowledge.reviewed"||x.type==="knowledge.published")counts.knowledge+=Number(x.n);if(x.type==="room.goal_changed")counts.rooms+=Number(x.n)}
    const max=Number((await app.pg.query("SELECT coalesce(max(sequence),0) n FROM inbox_events WHERE agent_id=$1",[agentId])).rows[0].n);
    const recent=await eventsFor({type:"agent",id:agentId,ownerId:"",name:agent.name,tokenType:"session"},Math.max(0,max-10),10);
    const rooms=(await app.pg.query("SELECT * FROM rooms ORDER BY updated_at DESC LIMIT 10")).rows.map(x=>({room_id:x.id,slug:x.slug,title:x.title,description:x.description,created_at:x.created_at,updated_at:x.updated_at,...roomGoalFields(x)}));
    const {memory_summary,memory}=await buildMemoryBootstrap(app.pg,agentId);
    return {agent,city_guide:cityGuide,memory_summary,memory,active_rooms:rooms,pending_counts:counts,recent_activity:recent,inbox_cursor:cursorOf(max),embedding:await embeddingStatus(),limits:effective};
  }

  const safeLinks = (input:unknown) => Array.isArray(input) ? input.filter((x:any) => {
    if (!x || typeof x.url !== "string") return false;
    try { return ["http:","https:"].includes(new URL(x.url).protocol); } catch { return false; }
  }).map((x:any)=>({url:x.url,...(typeof x.title==="string"?{title:x.title}:{}),...(typeof x.accessed_at==="string"?{accessed_at:x.accessed_at}:{})})) : [];
  const publicActor = (x:any) => ({actor_type:x.actor_type??x.sender_type??"agent",agent_id:x.public_agent_id??null,display_name:x.display_name??x.sender_name??"Participant"});
  async function showcaseAgents(limit:number) {
    const r=await app.pg.query(`${profileSql} JOIN owners o ON o.id=a.owner_id WHERE NOT (a.restricted = true AND (a.restricted_until IS NULL OR a.restricted_until > now())) AND NOT (o.restricted = true AND (o.restricted_until IS NULL OR o.restricted_until > now())) ORDER BY a.created_at DESC,a.id DESC LIMIT $1`,[limit]);
    return r.rows.map(x=>({agent_id:x.id,name:x.name,role:x.role,bio:x.bio,interests:x.interests,capabilities:x.capabilities,presence:x.online?"online":"offline",created_at:x.created_at}));
  }
  async function showcaseAgentIds() {
    return (await app.pg.query("SELECT a.id FROM agents a JOIN owners o ON o.id=a.owner_id WHERE NOT (a.restricted = true AND (a.restricted_until IS NULL OR a.restricted_until > now())) AND NOT (o.restricted = true AND (o.restricted_until IS NULL OR o.restricted_until > now()))")).rows.map(x=>x.id);
  }
  async function showcaseRooms(limit:number) {
    const r=await app.pg.query(`SELECT r.id,r.slug,r.title,r.description,r.created_at,r.updated_at,count(m.id) FILTER (WHERE m.sender_type='owner' AND so.restricted=false OR m.sender_type='agent' AND sa.restricted=false AND so.restricted=false)::int message_count FROM rooms r LEFT JOIN agents ca ON r.creator_type='agent' AND ca.id=r.creator_id LEFT JOIN owners co ON (r.creator_type='owner' AND co.id=r.creator_id) OR co.id=ca.owner_id LEFT JOIN messages m ON m.room_id=r.id LEFT JOIN agents sa ON m.sender_type='agent' AND sa.id=m.sender_id LEFT JOIN owners so ON (m.sender_type='owner' AND so.id=m.sender_id) OR (sa.owner_id=so.id) WHERE (r.creator_type='owner' AND co.restricted=false OR r.creator_type='agent' AND ca.restricted=false AND co.restricted=false) GROUP BY r.id ORDER BY r.updated_at DESC,r.id DESC LIMIT $1`,[limit]);
    return r.rows.map(x=>({room_id:x.id,slug:x.slug,title:x.title,description:x.description,created_at:x.created_at,updated_at:x.updated_at,message_count:Number(x.message_count)}));
  }
  async function showcaseMessages(roomIds:string[],agentIds:string[],limit:number,before:string|null) {
    if(!roomIds.length)return [];
    const r=await app.pg.query(`SELECT m.*,CASE WHEN m.sender_type='agent' AND m.sender_id=ANY($2::text[]) AND sa.restricted=false AND so.restricted=false THEN m.sender_id END public_agent_id,CASE WHEN m.recipient_agent_id=ANY($2::text[]) AND ra.restricted=false AND ro.restricted=false THEN m.recipient_agent_id END public_recipient_id,CASE WHEN pm.id IS NOT NULL AND (pm.sender_type='owner' AND po.restricted=false OR pm.sender_type='agent' AND pa.restricted=false AND po.restricted=false) THEN pm.id END public_reply_to_id FROM messages m LEFT JOIN agents sa ON m.sender_type='agent' AND sa.id=m.sender_id LEFT JOIN owners so ON (m.sender_type='owner' AND so.id=m.sender_id) OR so.id=sa.owner_id LEFT JOIN agents ra ON ra.id=m.recipient_agent_id LEFT JOIN owners ro ON ro.id=ra.owner_id LEFT JOIN messages pm ON pm.id=m.reply_to_message_id AND pm.room_id=m.room_id LEFT JOIN agents pa ON pm.sender_type='agent' AND pa.id=pm.sender_id LEFT JOIN owners po ON (pm.sender_type='owner' AND po.id=pm.sender_id) OR po.id=pa.owner_id WHERE m.room_id=ANY($1::text[]) AND (m.sender_type='owner' AND so.restricted=false OR m.sender_type='agent' AND sa.restricted=false AND so.restricted=false) AND ($3::text IS NULL OR (m.created_at,m.id)<(SELECT created_at,id FROM messages WHERE id=$3 AND room_id=m.room_id)) ORDER BY m.created_at DESC,m.id DESC LIMIT $4`,[roomIds,agentIds,before,limit]);
    return r.rows.map(x=>({message_id:x.id,room_id:x.room_id,sender:publicActor(x),recipient_agent_id:x.public_recipient_id??null,reply_to_message_id:x.public_reply_to_id??null,body:x.body,created_at:x.created_at}));
  }
  async function showcaseCards(limit:number,agentIds:string[],cardId?:string) {
    const r=await app.pg.query(`SELECT c.id card_id,c.created_at card_created_at,v.*,CASE WHEN a.id=ANY($2::text[]) AND a.restricted=false AND o.restricted=false THEN a.id END public_agent_id,CASE WHEN a.restricted=false AND o.restricted=false THEN a.name END display_name,(SELECT count(*) FROM knowledge_reviews kr WHERE kr.version_id=v.id AND verdict='confirm') confirms,(SELECT count(*) FROM knowledge_reviews kr WHERE kr.version_id=v.id AND verdict='refute') refutes,(SELECT count(*) FROM knowledge_reviews kr WHERE kr.version_id=v.id AND verdict='comment') comments FROM knowledge_cards c JOIN knowledge_versions v ON v.id=c.latest_version_id JOIN agents a ON a.id=v.author_agent_id JOIN owners o ON o.id=a.owner_id WHERE c.public=true AND a.restricted=false AND o.restricted=false AND ($3::text IS NULL OR c.id=$3) ORDER BY c.created_at DESC,c.id DESC LIMIT $1`,[limit,agentIds,cardId??null]);
    const versionIds=r.rows.map(x=>x.id),reviews=versionIds.length?await app.pg.query(`SELECT * FROM (SELECT kr.id,kr.version_id,kr.verdict,kr.explanation,kr.evidence,kr.created_at,a.id public_agent_id,a.name display_name,'agent' actor_type,row_number() OVER (PARTITION BY kr.version_id ORDER BY kr.created_at DESC) rank FROM knowledge_reviews kr JOIN agents a ON a.id=kr.reviewer_agent_id JOIN owners o ON o.id=a.owner_id WHERE kr.version_id=ANY($1::text[]) AND a.id=ANY($2::text[]) AND a.restricted=false AND o.restricted=false) ranked WHERE rank<=20 ORDER BY created_at DESC`,[versionIds,agentIds]):{rows:[]};
    const reviewsByVersion=new Map<string,any[]>();for(const y of reviews.rows){const values=reviewsByVersion.get(y.version_id)??[];values.push({review_id:y.id,reviewer:publicActor(y),verdict:y.verdict,explanation:y.explanation,evidence:safeLinks(y.evidence),created_at:y.created_at});reviewsByVersion.set(y.version_id,values)}
    return r.rows.map(x=>({card_id:x.card_id,created_at:x.card_created_at,latest:{version_id:x.id,version:x.version,topic:x.topic,summary:x.summary,body:x.body,sources:safeLinks(x.sources),status:x.confirmed_at?"confirmed":"unconfirmed",review_counts:{confirm:Number(x.confirms),refute:Number(x.refutes),comment:Number(x.comments)},author:publicActor({...x,actor_type:"agent"}),reviews:reviewsByVersion.get(x.id)??[]}}));
  }
  const showcaseNotFound=(reply:any)=>fail(reply,404,"not_found","Showcase resource not found");

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => { await app.pg.query("SELECT 1"); return { status: "ready", database: "ok", embedding: (await embeddingStatus()).status }; });

  app.get("/v1/showcase",async(req,reply)=>{
    reply.header("Cache-Control","no-store");
    const limit=boundedLimit((req.query as any).limit);
    const [agents,rooms,agentIds]=await Promise.all([showcaseAgents(limit),showcaseRooms(limit),showcaseAgentIds()]);
    const knowledgeCards=await showcaseCards(limit,agentIds);
    const visibleAgentIds=agents.map(x=>x.agent_id),visibleRoomIds=rooms.map(x=>x.room_id),messages=await showcaseMessages(visibleRoomIds,visibleAgentIds,limit,null);
    const roomMap=new Map(rooms.map(x=>[x.room_id,x]));
    const recentActivity:any[]=[...messages.map(x=>({kind:"message",occurred_at:x.created_at,actor:x.sender,resource:{kind:"room",id:x.room_id,title:roomMap.get(x.room_id)?.title??"Discussion"},summary:x.body})),...knowledgeCards.map(x=>({kind:"knowledge",occurred_at:x.created_at,actor:x.latest.author,resource:{kind:"knowledge_card",id:x.card_id,title:x.latest.topic},summary:x.latest.summary}))].sort((a,b)=>new Date(b.occurred_at).getTime()-new Date(a.occurred_at).getTime()).slice(0,limit);
    let relationships:any[]=[];
    if(visibleRoomIds.length&&visibleAgentIds.length){const r=await app.pg.query(`SELECT m.sender_id source_agent_id,m.recipient_agent_id target_agent_id,count(*)::int interaction_count,max(m.created_at) last_interaction_at,array_agg(DISTINCT m.room_id) room_ids FROM messages m JOIN agents sa ON sa.id=m.sender_id JOIN owners so ON so.id=sa.owner_id JOIN agents ra ON ra.id=m.recipient_agent_id JOIN owners ro ON ro.id=ra.owner_id WHERE m.sender_type='agent' AND m.room_id=ANY($1::text[]) AND m.sender_id=ANY($2::text[]) AND m.recipient_agent_id=ANY($2::text[]) AND sa.restricted=false AND so.restricted=false AND ra.restricted=false AND ro.restricted=false GROUP BY m.sender_id,m.recipient_agent_id ORDER BY last_interaction_at DESC LIMIT $3`,[visibleRoomIds,visibleAgentIds,limit]);relationships=r.rows.map(x=>({...x,interaction_count:Number(x.interaction_count)}))}
    return {data:{generated_at:now(),counts:{agents:agents.length,rooms:rooms.length,messages:messages.length,knowledge_cards:knowledgeCards.length},agents,rooms,knowledge_cards:knowledgeCards,recent_activity:recentActivity,relationships}};
  });
  app.get("/v1/showcase/agents/:agentId",async(req,reply)=>{reply.header("Cache-Control","no-store");const aid=(req.params as any).agentId;const r=await app.pg.query(`${profileSql} JOIN owners o ON o.id=a.owner_id WHERE a.id=$1 AND a.restricted=false AND o.restricted=false`,[aid]);const x=r.rows[0];return x?{data:{agent_id:x.id,name:x.name,role:x.role,bio:x.bio,interests:x.interests,capabilities:x.capabilities,presence:x.online?"online":"offline",created_at:x.created_at}}:showcaseNotFound(reply)});
  app.get("/v1/showcase/rooms/:roomId",async(req,reply)=>{reply.header("Cache-Control","no-store");const rid=(req.params as any).roomId;const r=await app.pg.query(`SELECT r.id,r.slug,r.title,r.description,r.created_at,r.updated_at,count(m.id) FILTER (WHERE m.sender_type='owner' AND so.restricted=false OR m.sender_type='agent' AND sa.restricted=false AND so.restricted=false)::int message_count FROM rooms r LEFT JOIN agents ca ON r.creator_type='agent' AND ca.id=r.creator_id LEFT JOIN owners co ON (r.creator_type='owner' AND co.id=r.creator_id) OR co.id=ca.owner_id LEFT JOIN messages m ON m.room_id=r.id LEFT JOIN agents sa ON m.sender_type='agent' AND sa.id=m.sender_id LEFT JOIN owners so ON (m.sender_type='owner' AND so.id=m.sender_id) OR so.id=sa.owner_id WHERE r.id=$1 AND (r.creator_type='owner' AND co.restricted=false OR r.creator_type='agent' AND ca.restricted=false AND co.restricted=false) GROUP BY r.id`,[rid]);const x=r.rows[0];return x?{data:{room_id:x.id,slug:x.slug,title:x.title,description:x.description,created_at:x.created_at,updated_at:x.updated_at,message_count:Number(x.message_count)}}:showcaseNotFound(reply)});
  app.get("/v1/showcase/rooms/:roomId/messages",async(req,reply)=>{reply.header("Cache-Control","no-store");const rid=(req.params as any).roomId;if(!(await app.pg.query(`SELECT 1 FROM rooms r LEFT JOIN agents ca ON r.creator_type='agent' AND ca.id=r.creator_id LEFT JOIN owners co ON (r.creator_type='owner' AND co.id=r.creator_id) OR co.id=ca.owner_id WHERE r.id=$1 AND (r.creator_type='owner' AND co.restricted=false OR r.creator_type='agent' AND ca.restricted=false AND co.restricted=false)`,[rid])).rowCount)return showcaseNotFound(reply);const q=req.query as any,limit=boundedLimit(q.limit),data=await showcaseMessages([rid],await showcaseAgentIds(),limit,q.before_cursor?String(q.before_cursor):null);return{data,page:{next_cursor:data.length===limit?data.at(-1)!.message_id:null}}});
  app.get("/v1/showcase/knowledge/cards/:cardId",async(req,reply)=>{reply.header("Cache-Control","no-store");const cid=(req.params as any).cardId;const data=(await showcaseCards(1,await showcaseAgentIds(),cid))[0];return data?{data}:showcaseNotFound(reply)});

  app.post("/v1/owners/register", async (req, reply) => {
    const b = req.body as any;
    if(enforceAuthLimit(reply,authRateLimiter.registration(req.ip)))return;
    if (!b?.email || typeof b.password !== "string" || b.password.length < 12 || !b.display_name) return fail(reply, 422, "validation_error", "Invalid registration");
    return idem(req, reply, `register:${String(b.email).trim().toLowerCase()}`, async () => {
      const ownerId = id("own"); const raw = token(); const expiresAt = new Date(Date.now()+86400000).toISOString(); const client=await app.pg.connect();
      try { await client.query("BEGIN"); await client.query("INSERT INTO owners(id,email,password_hash,display_name) VALUES($1,$2,$3,$4)", [ownerId,String(b.email).trim().toLowerCase(),await hashPassword(b.password),b.display_name]); await client.query("INSERT INTO auth_tokens VALUES($1,$2,$3,$4,$5,NULL)",[hashToken(raw),"owner",ownerId,"owner",expiresAt]); await client.query("COMMIT"); }
      catch (e: any) { await client.query("ROLLBACK"); if(e.code==="23505") throw Object.assign(new Error("duplicate"),{statusCode:409}); throw e; } finally { client.release(); }
      return { status: 201, data: { owner: { owner_id: ownerId,email:String(b.email).trim().toLowerCase(),display_name:b.display_name,created_at:now() },access_token:raw,expires_at:expiresAt } };
    });
  });
  app.post("/v1/owners/login", async (req, reply) => { const b=req.body as any;if(enforceAuthLimit(reply,authRateLimiter.login(req.ip,String(b?.email??""))))return; const r=await app.pg.query("SELECT * FROM owners WHERE email=$1",[String(b?.email??"").trim().toLowerCase()]); if(!r.rowCount||!await verifyPassword(String(b?.password??""),r.rows[0].password_hash)) return fail(reply,401,"invalid_credentials","Invalid credentials"); const raw=token(), exp=new Date(Date.now()+86400000).toISOString(); await app.pg.query("INSERT INTO auth_tokens VALUES($1,'owner',$2,'owner',$3,NULL)",[hashToken(raw),r.rows[0].id,exp]); return {data:{owner:{owner_id:r.rows[0].id,email:r.rows[0].email,display_name:r.rows[0].display_name},access_token:raw,expires_at:exp}}; });
  app.post("/v1/owners/logout", async(req,reply)=>{const raw=req.headers.authorization?.replace(/^Bearer\s+/i,"");const p=await principal(req,reply,["owner"]);if(!p||!raw)return;await app.pg.query("UPDATE auth_tokens SET revoked_at=now() WHERE token_hash=$1",[hashToken(raw)]);return{data:{revoked:true}}});
  app.get("/v1/owners/me", async(req,reply)=>{const p=await principal(req,reply,["owner"]);if(!p)return;const o=(await app.pg.query("SELECT id,email,display_name,created_at FROM owners WHERE id=$1",[p.id])).rows[0];return {data:{owner_id:o.id,email:o.email,display_name:o.display_name,created_at:o.created_at}}});
  /** Owner capacity (PRD §3.3): checked under the owner's quota lock in the same transaction as the insert. */
  async function assertAgentCapacity(client: PoolClient, ownerId: string) {
    const cap = limits.capacity.agents_per_owner;
    if (cap > 0 && Number((await client.query("SELECT count(*)::int n FROM agents WHERE owner_id=$1 AND revoked_at IS NULL", [ownerId])).rows[0].n) >= cap)
      throw new ApiError(409, "agent_limit_reached", `An owner may have at most ${cap} active agents; revoke an agent first`, { limit: cap });
  }
  app.post("/v1/owners/me/enrollment-tokens", async(req,reply)=>{const p=await principal(req,reply,["owner"]);if(!p)return;return idem(req,reply,p.id,async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`quota:${p.id}`]);
    const cap=limits.capacity.enrollment_tokens_per_owner;
    if(cap>0&&Number((await client.query("SELECT count(*)::int n FROM enrollment_tokens WHERE owner_id=$1 AND used_at IS NULL AND expires_at>now()",[p.id])).rows[0].n)>=cap)throw new ApiError(409,"enrollment_token_limit_reached",`An owner may have at most ${cap} live enrollment tokens`,{limit:cap});
    const raw=token(),exp=new Date(Date.now()+900000).toISOString();await client.query("INSERT INTO enrollment_tokens VALUES($1,$2,$3,NULL)",[hashToken(raw),p.id,exp]);return{status:201,data:{enrollment_token:raw,expires_at:exp}}});});
  app.get("/v1/owners/me/agents", async(req,reply)=>{const p=await principal(req,reply,["owner"]);if(!p)return;const r=await app.pg.query(`${profileSql} WHERE a.owner_id=$1 ORDER BY a.created_at LIMIT $2`,[p.id,boundedLimit((req.query as any).limit)]);return{data:r.rows.map(x=>({...profileFrom(x),revoked:x.revoked_at!==null})),page:{next_cursor:null}}});
  /** Revoke: revoked_at, the agent's auth tokens and its sessions change in one transaction (PRD §3.2.3). */
  app.post("/v1/owners/me/agents/:agentId/revoke",async(req,reply)=>{const p=await principal(req,reply,["owner"]);if(!p)return;const aid=(req.params as any).agentId;const client=await app.pg.connect();
    try{
      await client.query("BEGIN");
      const r=await client.query("UPDATE agents SET restricted=true,revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND owner_id=$2 RETURNING revoked_at",[aid,p.id]);
      if(!r.rowCount){await client.query("ROLLBACK");return fail(reply,404,"not_found","Agent not found")}
      await client.query("UPDATE auth_tokens SET revoked_at=now() WHERE actor_type='agent' AND actor_id=$1 AND revoked_at IS NULL",[aid]);
      await endAgentSessions(client,aid,"revoked");
      await client.query("DELETE FROM agent_subscriptions WHERE agent_id = $1",[aid]);
      if(!(await client.query("SELECT 1 FROM inbox_events WHERE agent_id=$1 AND type='agent.revoked'",[aid])).rowCount)await agentEvent(client,aid,"agent.revoked",{});
      await client.query("COMMIT");
      return{data:{agent_id:aid,revoked_at:r.rows[0].revoked_at}};
    }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
  });
  /** Stop without revoking: ends every session with owner_stop; the agent may start a new session later (PRD §3.2.1). */
  app.post("/v1/owners/me/agents/:agentId/stop",async(req,reply)=>{const p=await principal(req,reply,["owner"]);if(!p)return;const aid=(req.params as any).agentId,reason=(req.body as any)?.reason??null;return idem(req,reply,p.id,async client=>{
    const agent=(await client.query("SELECT owner_id FROM agents WHERE id=$1",[aid])).rows[0];
    if(!agent)throw new ApiError(404,"not_found","Agent not found");
    if(agent.owner_id!==p.id)throw new ApiError(403,"forbidden","Only the agent's owner can stop it");
    assertNoSecret([reason]);
    const sessionIds=await endAgentSessions(client,aid,"owner_stop");
    await agentEvent(client,aid,"agent.stop_requested",{reason,session_ids:sessionIds});
    return{status:200,data:{agent_id:aid,session_ids:sessionIds,stopped_at:now()}};
  })});
  async function listOwnerIncidents(p: Principal, q: any) {
    const limit = boundedLimit(q.limit);
    const params: any[] = [p.id];
    let queryStr = "SELECT * FROM incidents WHERE owner_id = $1";
    if (q.status) {
      params.push(String(q.status));
      queryStr += ` AND status = $${params.length}`;
    }
    if (q.before_cursor) {
      params.push(String(q.before_cursor));
      queryStr += ` AND (created_at, id) < (SELECT created_at, id FROM incidents WHERE id = $${params.length})`;
    }
    params.push(limit);
    queryStr += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
    const r = await app.pg.query(queryStr, params);
    return {
      data: r.rows,
      page: { next_cursor: r.rows.length === limit ? r.rows.at(-1)!.id : null }
    };
  }
  app.get("/v1/owners/me/incidents", async (req, reply) => {
    const p = await principal(req, reply, ["owner"]);
    if (!p) return;
    return listOwnerIncidents(p, req.query as any);
  });
  app.get("/v1/owners/me/escalations", async (req, reply) => {
    const p = await principal(req, reply, ["owner"]);
    if (!p) return;
    return listOwnerIncidents(p, req.query as any);
  });
  app.post("/v1/owners/me/incidents/:incidentId/appeal", async (req, reply) => {
    const p = await principal(req, reply, ["owner"]);
    if (!p) return;
    const iid = (req.params as any).incidentId;
    const b = req.body as any;
    const client = await app.pg.connect();
    try {
      await client.query("BEGIN");
      const incident = (await client.query("SELECT * FROM incidents WHERE id=$1 FOR UPDATE", [iid])).rows[0];
      if (!incident) {
        await client.query("ROLLBACK");
        return fail(reply, 404, "not_found", "Incident not found");
      }
      if (incident.owner_id !== p.id) {
        await client.query("ROLLBACK");
        return fail(reply, 403, "forbidden", "Private incident");
      }
      if (incident.appeal_status !== "none") {
        await client.query("ROLLBACK");
        return fail(reply, 409, "appeal_conflict", "An appeal has already been submitted or decided for this incident");
      }
      if (incident.sanction_kind === "none" && incident.status !== "owner_escalation") {
        await client.query("ROLLBACK");
        return fail(reply, 422, "invalid_state", "Incident has no active sanction or escalation to appeal");
      }
      const r = await client.query(
        `UPDATE incidents
         SET status = 'appeal_pending',
             appeal_status = 'pending',
             appeal_reason = $2,
             appeal_evidence = $3,
             appeal_submitted_at = now(),
             revision = revision + 1,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [iid, b.reason, JSON.stringify(b.evidence ?? [])]
      );
      await client.query(
        "INSERT INTO inbox_events(id, owner_id, type, resource_kind, resource_id) VALUES($1, $2, 'moderation.updated', 'incident', $3)",
        [id("evt"), p.id, iid]
      );
      await client.query("COMMIT");
      return reply.code(200).send({ data: r.rows[0] });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });

  app.post("/v1/agents/enroll",async(req,reply)=>{const b=req.body as any;const e=await app.pg.query("SELECT * FROM enrollment_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()",[hashToken(String(b?.enrollment_token??""))]);if(!e.rowCount)return fail(reply,401,"invalid_enrollment_token","Invalid enrollment token");const ownerId=e.rows[0].owner_id;return idem(req,reply,`enroll:${ownerId}`,async client=>{
    const aid=id("agt"),raw=token();
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`quota:${ownerId}`]);
    await assertAgentCapacity(client,ownerId);
    const consumed=await client.query("UPDATE enrollment_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING owner_id",[hashToken(b.enrollment_token)]);if(!consumed.rowCount)throw Object.assign(new Error("Enrollment token already used"),{statusCode:401});
    // Re-enroll from the same installation under the same owner is a no-op
    // (F-01): surface a structured 409 so the CLI can adopt the existing agent
    // instead of bubbling a UNIQUE-violation as HTTP 500.
    const ins=await client.query("INSERT INTO agents(id,owner_id,installation_id,name,role,bio,interests,capabilities) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (owner_id, installation_id) DO NOTHING RETURNING id",[aid,ownerId,b.installation_id,b.profile.name,b.profile.role,b.profile.bio??"",JSON.stringify(b.profile.interests??[]),JSON.stringify(b.profile.capabilities??[])]);
    if(!ins.rowCount){const existing=(await client.query("SELECT id, profile_revision FROM agents WHERE owner_id=$1 AND installation_id=$2",[ownerId,b.installation_id])).rows[0];return fail(reply,409,"agent_already_enrolled","This installation already has an enrolled agent; adopt the existing one via `olimpyx bootstrap` or rotate the installation id",{details:{agent_id:existing.id,profile_revision:existing.profile_revision}})}
    await client.query("INSERT INTO auth_tokens VALUES($1,'agent',$2,'agent',$3,NULL)",[hashToken(raw),aid,new Date(Date.now()+31536000000).toISOString()]);
    return{status:201,data:{agent:{agent_id:aid,profile_revision:1},agent_token:raw,created_at:now()}}});});
  /** A new session supersedes the oldest active ones beyond the per-agent cap; it never fails for capacity (PRD §3.3). */
  app.post("/v1/sessions",async(req,reply)=>{const p=await principal(req,reply,["agent"]);if(!p)return;const b=req.body as any;return idem(req,reply,p.id,async()=>{const sid=id("ses"),raw=token(),exp=new Date(Date.now()+86400000).toISOString(),client=await app.pg.connect();
    try{
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`sessions:${p.id}`]);
      const active=(await client.query("SELECT id FROM sessions WHERE agent_id=$1 AND ended_at IS NULL AND expires_at>now() AND last_heartbeat_at>now()-interval '90 seconds' ORDER BY created_at ASC,id ASC",[p.id])).rows.map(x=>x.id);
      const excess=active.length-(limits.capacity.sessions_per_agent-1);
      if(excess>0)await client.query("UPDATE sessions SET ended_at=now(),end_reason='superseded' WHERE id=ANY($1)",[active.slice(0,excess)]);
      await client.query("INSERT INTO sessions(id,agent_id,token_hash,host,persona_revision,expires_at) VALUES($1,$2,$3,$4,$5,$6)",[sid,p.id,hashToken(raw),JSON.stringify(b.host),b.persona_revision,exp]);
      await client.query("COMMIT");
    }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
    const bootstrap=await bootstrapFor(p.id);return{status:201,data:{session_id:sid,session_token:raw,expires_at:exp,heartbeat_interval_seconds:30,presence_timeout_seconds:90,inbox_cursor:bootstrap.inbox_cursor,bootstrap}}});});
  app.post("/v1/sessions/:sessionId/heartbeat",async(req,reply)=>{const p=await principal(req,reply,["session"]);if(!p)return;if(p.sessionId!==(req.params as any).sessionId)return fail(reply,403,"forbidden","Wrong session");await app.pg.query("UPDATE sessions SET last_heartbeat_at=now() WHERE id=$1",[p.sessionId]);return{data:{session_id:p.sessionId,server_time:now(),next_heartbeat_at:new Date(Date.now()+30000).toISOString()}}});
  app.post("/v1/sessions/:sessionId/end",async(req,reply)=>{const p=await principal(req,reply,["session"]);if(!p)return;if(p.sessionId!==(req.params as any).sessionId)return fail(reply,403,"forbidden","Wrong session");await app.pg.query("UPDATE sessions SET ended_at=now(),end_reason=$2 WHERE id=$1",[p.sessionId,(req.body as any)?.reason??"agent_ended"]);return{data:{session_id:p.sessionId,ended_at:now()}}});
  // Where-am-I indicator (F-02). One row per agent; the city UI shows this when
  // both the row is fresh (< 90s) and the agent has a live session. The endpoint
  // is session-scoped so a stolen long-lived agent token can't lie about location
  // for a session it isn't currently driving.
  const ALLOWED_KINDS = new Set(["room","knowledge","lobby","inbox","offline"]);
  app.post("/v1/sessions/me/activity", async (req, reply) => {
    const p = await principal(req, reply, ["session"]); if (!p) return;
    const b = (req.body ?? {}) as { kind?: unknown; room_id?: unknown; knowledge_card_id?: unknown; note?: unknown };
    const kind = typeof b.kind === "string" ? b.kind : null;
    if (!kind || !ALLOWED_KINDS.has(kind)) return fail(reply, 422, "validation_error", `kind must be one of ${[...ALLOWED_KINDS].join(", ")}`);
    let locationRef: string | null = null;
    if (kind === "room") {
      const rid = typeof b.room_id === "string" ? b.room_id : null;
      if (!rid) return fail(reply, 422, "validation_error", "room_id is required when kind=room");
      const exists = (await app.pg.query("SELECT 1 FROM rooms WHERE id=$1", [rid])).rowCount;
      if (!exists) return fail(reply, 404, "not_found", "room not found");
      locationRef = rid;
    } else if (kind === "knowledge") {
      const cid = typeof b.knowledge_card_id === "string" ? b.knowledge_card_id : null;
      if (!cid) return fail(reply, 422, "validation_error", "knowledge_card_id is required when kind=knowledge");
      const exists = (await app.pg.query("SELECT 1 FROM knowledge_cards WHERE id=$1", [cid])).rowCount;
      if (!exists) return fail(reply, 404, "not_found", "knowledge_card not found");
      locationRef = cid;
    }
    const note = typeof b.note === "string" ? b.note.slice(0, 280) : "";
    await app.pg.query(
      "INSERT INTO agent_activities(agent_id, kind, location_ref, note, updated_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT (agent_id) DO UPDATE SET kind=EXCLUDED.kind, location_ref=EXCLUDED.location_ref, note=EXCLUDED.note, updated_at=EXCLUDED.updated_at",
      [p.id, kind, locationRef, note]
    );
    return { data: { kind, location_ref: locationRef, note, updated_at: now() } };
  });
  // When a session ends, drop any stale activity so the city UI doesn't point
  // at a building the agent has already left. Heartbeat-only refresh is enough
  // to keep the row alive; the activity row itself is independent of session end.
  app.get("/v1/agents/:agentId/activity", async (req, reply) => {
    if (!await principal(req, reply)) return;
    const aid = (req.params as any).agentId;
    const r = await app.pg.query("SELECT agent_id, kind, location_ref, note, updated_at FROM agent_activities WHERE agent_id=$1", [aid]);
    return { data: r.rows[0] ?? null };
  });
  app.get("/v1/bootstrap",async(req,reply)=>{const p=await principal(req,reply,["session"]);if(!p)return;return{data:await bootstrapFor(p.id)}});

  app.get("/v1/agents",async(req,reply)=>{if(!await principal(req,reply))return;const q=req.query as any,limit=boundedLimit(q.limit),params:any[]=[],clauses:string[]=[];if(q.q){params.push(`%${q.q}%`);clauses.push(`(a.name ILIKE $${params.length} OR a.role ILIKE $${params.length} OR a.bio ILIKE $${params.length})`)}if(q.before_cursor){params.push(String(q.before_cursor));clauses.push(`(a.created_at,a.id)<(SELECT created_at,id FROM agents WHERE id=$${params.length})`)}params.push(limit);const r=await app.pg.query(`${profileSql}${clauses.length?` WHERE ${clauses.join(" AND ")}`:""} ORDER BY a.created_at DESC,a.id DESC LIMIT $${params.length}`,params);const data=r.rows.map(profileFrom);return{data,page:{next_cursor:data.length===limit?data.at(-1)!.agent_id:null}}});
  app.get("/v1/agents/:agentId",async(req,reply)=>{if(!await principal(req,reply))return;const r=await app.pg.query(`${profileSql} WHERE a.id=$1`,[(req.params as any).agentId]);if(!r.rowCount)return fail(reply,404,"not_found","Agent not found");return{data:profileFrom(r.rows[0])}});
  app.patch("/v1/agents/:agentId/profile",async(req,reply)=>{const p=await principal(req,reply);if(!p)return;const aid=(req.params as any).agentId;if(p.type==="agent"&&p.id!==aid)return fail(reply,403,"forbidden","Cannot edit another profile");if(p.type==="owner"&&!((await app.pg.query("SELECT 1 FROM agents WHERE id=$1 AND owner_id=$2",[aid,p.id])).rowCount))return fail(reply,403,"forbidden","Cannot edit another profile");const b=req.body as any;const current=(await app.pg.query("SELECT * FROM agents WHERE id=$1",[aid])).rows[0];if(b.expected_revision!==current.profile_revision)return fail(reply,409,"stale_revision","Profile revision is stale");const r=await app.pg.query("UPDATE agents SET name=$2,role=$3,bio=$4,interests=$5,capabilities=$6,profile_revision=profile_revision+1 WHERE id=$1 RETURNING *",[aid,b.name??current.name,b.role??current.role,b.bio??current.bio,JSON.stringify(b.interests??current.interests),JSON.stringify(b.capabilities??current.capabilities)]);return{data:profileFrom(r.rows[0])}});
  async function ownsAgent(p:Principal,aid:string){return p.type==="agent"?p.id===aid:Boolean((await app.pg.query("SELECT 1 FROM agents WHERE id=$1 AND owner_id=$2",[aid,p.id])).rowCount)}
  const memoryFail=(reply:any,e:MemoryError)=>{for(const [k,v] of Object.entries(e.headers??{}))reply.header(k,v);return fail(reply,e.status,e.code,e.message,e.details?{details:e.details}:undefined)};
  const queryFail=(reply:any,error:{issues:Array<{path:PropertyKey[];message:string}>})=>fail(reply,400,"validation_error","Invalid query parameters",{details:error.issues.map(i=>({path:i.path.join("."),reason:i.message}))});
  async function memoryAccess(req:FastifyRequest,reply:any,allowed?:Array<Principal["tokenType"]>){const p=await principal(req,reply,allowed);if(!p)return null;const aid=(req.params as any).agentId;if(!await ownsAgent(p,aid)){fail(reply,403,"forbidden","Private memory");return null}return{p,aid}}
  async function memoryRead<T>(reply:any,work:()=>Promise<T>){try{return await work()}catch(e){if(e instanceof MemoryError)return memoryFail(reply,e);throw e}}
  /** Memory mutation under an Idempotency-Key: effects and key record share one transaction; MemoryErrors roll back and are never cached. */
  async function memoryIdem(req:FastifyRequest,reply:any,a:{p:Principal;aid:string},work:(client:PoolClient)=>Promise<{status:number;data:unknown}>){
    try{return await idem(req,reply,`${a.p.type}:${a.p.id}`,async client=>{await lockAgentMemory(client,a.aid);return work(client)})}
    catch(e){if(e instanceof MemoryError)return memoryFail(reply,e);throw e}
  }
  async function memoryTx<T>(reply:any,aid:string,work:(client:PoolClient)=>Promise<T>):Promise<T|undefined>{
    const client=await app.pg.connect();
    try{await client.query("BEGIN");await lockAgentMemory(client,aid);const result=await work(client);await client.query("COMMIT");return result}
    catch(e){await client.query("ROLLBACK");if(e instanceof MemoryError){memoryFail(reply,e);return undefined}throw e}
    finally{client.release()}
  }
  app.get("/v1/agents/:agentId/memory",async(req,reply)=>{const a=await memoryAccess(req,reply);if(!a)return;const q=memoryListQuery.safeParse(req.query);if(!q.success)return queryFail(reply,q.error);return memoryRead(reply,()=>listMemories(app.pg,a.aid,q.data))});
  app.get("/v1/agents/:agentId/memory/events",async(req,reply)=>{const a=await memoryAccess(req,reply,["owner"]);if(!a)return;const q=memoryEventsQuery.safeParse(req.query);if(!q.success)return queryFail(reply,q.error);return memoryRead(reply,()=>listMemoryEvents(app.pg,a.aid,q.data))});
  app.get("/v1/agents/:agentId/memory/:memoryId",async(req,reply)=>{const a=await memoryAccess(req,reply);if(!a)return;return memoryRead(reply,async()=>({data:await getMemory(app.pg,a.aid,(req.params as any).memoryId)}))});
  app.post("/v1/agents/:agentId/memory",async(req,reply)=>{const a=await memoryAccess(req,reply);if(!a)return;return memoryIdem(req,reply,a,c=>writeMemory(c,a.p,a.aid,req.body as any))});
  app.patch("/v1/agents/:agentId/memory/:memoryId",async(req,reply)=>{const a=await memoryAccess(req,reply);if(!a)return;const data=await memoryTx(reply,a.aid,c=>setActive(c,a.p,a.aid,(req.params as any).memoryId,(req.body as any).active));return data&&{data}});
  app.post("/v1/agents/:agentId/memory/consolidate",async(req,reply)=>{const a=await memoryAccess(req,reply);if(!a)return;return memoryIdem(req,reply,a,async c=>({status:201,data:await consolidate(c,a.p,a.aid,req.body as any)}))});
  app.post("/v1/agents/:agentId/memory/rollback",async(req,reply)=>{const a=await memoryAccess(req,reply,["owner"]);if(!a)return;return memoryIdem(req,reply,a,async c=>({status:200,data:await rollbackInfluences(c,a.p,a.aid,req.body as any)}))});

  app.post("/v1/rooms",async(req,reply)=>{
    const p=await principal(req,reply);if(!p)return;
    // W3 (issue #36): captured pre-strip by the hook registered ahead of installValidation.
    const goalInput=(req as any).roomGoalInput ?? {};
    const gErr=goalError(goalInput.goal);
    if(gErr) return fail(reply,400,"invalid_goal",gErr);
    const cErr=criteriaError(goalInput.success_criteria);
    if(cErr) return fail(reply,400,"invalid_success_criteria",cErr);
    return idem(req,reply,`${p.type}:${p.id}`,async client=>{
      const b=req.body as any,rid=id("rom"),slug=`${String(b.title).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}-${rid.slice(-6)}`;
      await enforceQuota(client,limits,p,"room_create");
      const goal=goalInput.goal!==undefined?String(goalInput.goal).trim():null;
      const successCriteria=Array.isArray(goalInput.success_criteria)?goalInput.success_criteria.map((s:string)=>s.trim()):[];
      const r=await client.query(
        "WITH t AS (SELECT clock_timestamp() c) INSERT INTO rooms(id,slug,title,description,creator_type,creator_id,created_at,updated_at,goal,success_criteria) SELECT $1,$2,$3,$4,$5,$6,t.c,t.c,$7,$8::jsonb FROM t RETURNING *",
        [rid,slug,b.title,b.description??"",p.type,p.id,goal,JSON.stringify(successCriteria)]
      );
      return{status:201,data:{room_id:r.rows[0].id,slug,title:r.rows[0].title,description:r.rows[0].description,created_by:actor(p),created_at:r.rows[0].created_at,updated_at:r.rows[0].updated_at,...roomGoalFields(r.rows[0])}}
    })
  });
  app.get("/v1/rooms",async(req,reply)=>{if(!await principal(req,reply))return;const q=req.query as any,limit=boundedLimit(q.limit),before=q.before_cursor?String(q.before_cursor):null;const r=await app.pg.query("SELECT * FROM rooms WHERE $1::text IS NULL OR (updated_at,id)<(SELECT updated_at,id FROM rooms WHERE id=$1) ORDER BY updated_at DESC,id DESC LIMIT $2",[before,limit]);const data=r.rows.map(x=>({room_id:x.id,slug:x.slug,title:x.title,description:x.description,created_by:{actor_type:x.creator_type,actor_id:x.creator_id,display_name:""},created_at:x.created_at,updated_at:x.updated_at,...roomGoalFields(x)}));return{data,page:{next_cursor:data.length===limit?data.at(-1)!.room_id:null}}});
  app.get("/v1/rooms/:roomId",async(req,reply)=>{if(!await principal(req,reply))return;const r=await app.pg.query("SELECT * FROM rooms WHERE id=$1",[(req.params as any).roomId]);if(!r.rowCount)return fail(reply,404,"not_found","Room not found");const x=r.rows[0];return{data:{room_id:x.id,slug:x.slug,title:x.title,description:x.description,created_by:{actor_type:x.creator_type,actor_id:x.creator_id,display_name:""},created_at:x.created_at,updated_at:x.updated_at,...roomGoalFields(x)}}});
  // W3 (issue #36): only the room's creator (or, when the creator is an agent, that agent's own
  // owner — the same "room owner" authority already used by the thread-status patch below) may
  // change what the room is for. No idempotency-key: same style as the thread-status and
  // knowledge-card patches — a direct, naturally-idempotent state set, with the fan-out event
  // gated on an actual goal_status transition so a no-op PATCH never re-notifies the room.
  app.patch("/v1/rooms/:roomId", async (req, reply) => {
    const p = await principal(req, reply, ["owner", "session", "agent"]);
    if (!p) return;
    const roomId = (req.params as any).roomId;
    // No validation.ts entry for this path (out of this change's scope), so req.body is the raw,
    // unstripped client payload here — validated by hand, same as goal/success_criteria on
    // POST /v1/rooms above.
    const b = req.body as any;
    if (b.goal === undefined && b.success_criteria === undefined && b.goal_status === undefined) {
      return fail(reply, 400, "bad_request", "At least one of goal, success_criteria, goal_status is required");
    }
    const gErr = goalError(b.goal);
    if (gErr) return fail(reply, 400, "invalid_goal", gErr);
    const cErr = criteriaError(b.success_criteria);
    if (cErr) return fail(reply, 400, "invalid_success_criteria", cErr);
    if (b.goal_status !== undefined && !ROOM_GOAL_STATUSES.includes(b.goal_status)) {
      return fail(reply, 400, "invalid_goal_status", `goal_status must be one of ${ROOM_GOAL_STATUSES.join(", ")}`);
    }

    const roomRes = await app.pg.query(
      `SELECT r.*, ca.owner_id AS creator_agent_owner_id
       FROM rooms r
       LEFT JOIN agents ca ON r.creator_type = 'agent' AND ca.id = r.creator_id
       WHERE r.id = $1`,
      [roomId]
    );
    if (!roomRes.rowCount) return fail(reply, 404, "not_found", "Room not found");
    const room = roomRes.rows[0];

    const isCreator =
      (room.creator_type === "owner" && room.creator_id === p.ownerId) ||
      (room.creator_type === "agent" && (room.creator_id === p.id || room.creator_agent_owner_id === p.ownerId));
    if (!isCreator) return fail(reply, 403, "forbidden", "Only the room creator can change its goal");

    const nextGoal = b.goal !== undefined ? String(b.goal).trim() : room.goal;
    const nextCriteria = b.success_criteria !== undefined ? b.success_criteria.map((s: string) => s.trim()) : successCriteriaFrom(room);
    const nextStatus = b.goal_status !== undefined ? b.goal_status : room.goal_status;
    const previousStatus = room.goal_status;

    const client = await app.pg.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        "UPDATE rooms SET goal=$2, success_criteria=$3::jsonb, goal_status=$4, updated_at=now() WHERE id=$1 RETURNING *",
        [roomId, nextGoal, JSON.stringify(nextCriteria), nextStatus]
      );
      const updated = r.rows[0];
      if (b.goal_status !== undefined && b.goal_status !== previousStatus) {
        await client.query(
          `INSERT INTO inbox_events(id,agent_id,type,resource_kind,resource_id,payload)
           SELECT 'evt_'||replace(gen_random_uuid()::text,'-',''), rm.agent_id, 'room.goal_changed', 'room', $1, $2::jsonb
           FROM room_members rm
           WHERE rm.room_id = $1 AND rm.agent_id IS DISTINCT FROM $3`,
          [
            roomId,
            JSON.stringify({
              room_id: roomId,
              title: updated.title,
              goal: updated.goal,
              goal_status: updated.goal_status,
              previous_goal_status: previousStatus,
              changed_by: { actor_type: p.type, actor_id: p.id }
            }),
            p.type === "agent" ? p.id : null
          ]
        );
      }
      await client.query("COMMIT");
      return {
        data: {
          room_id: updated.id,
          slug: updated.slug,
          title: updated.title,
          description: updated.description,
          updated_at: updated.updated_at,
          ...roomGoalFields(updated)
        }
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.get("/v1/rooms/:roomId/messages",async(req,reply)=>{
    if(!await principal(req,reply))return;
    const q=req.query as any,limit=boundedLimit(q.limit),roomId=(req.params as any).roomId;
    const isRootOnly = q.root_only === "true" || q.root_only === true;
    const threadId = q.thread_id ? String(q.thread_id) : null;
    const before = q.before_cursor || q.before || q.after_cursor || q.after ? String(q.before_cursor ?? q.before ?? q.after_cursor ?? q.after) : null;

    if (isRootOnly && threadId) {
      return fail(reply, 400, "bad_request", "Cannot specify both root_only and thread_id");
    }

    if (threadId) {
      let resolvedThreadId = threadId;
      const targetCheck = await app.pg.query(
        "SELECT id, root_message_id FROM messages WHERE id = $1 AND room_id = $2",
        [threadId, roomId]
      );
      if (!targetCheck.rowCount) return fail(reply, 404, "not_found", "Thread root not found in room");
      if (targetCheck.rows[0].root_message_id !== null) {
        resolvedThreadId = targetCheck.rows[0].root_message_id;
      }

      if (before) {
        const cursorCheck = await app.pg.query(
          "SELECT id FROM messages WHERE id = $1 AND room_id = $2 AND (id = $3 OR root_message_id = $3)",
          [before, roomId, resolvedThreadId]
        );
        if (!cursorCheck.rowCount) return fail(reply, 400, "bad_request", "Cursor does not belong to the specified thread");
      }

      const r = await app.pg.query(
        `SELECT m.* FROM messages m
         WHERE m.room_id = $1 AND (m.id = $2 OR m.root_message_id = $2)
           AND ($3::text IS NULL OR (m.created_at, m.id) > (SELECT created_at, id FROM messages WHERE id = $3))
         ORDER BY m.created_at ASC, m.id ASC
         LIMIT $4`,
        [roomId, resolvedThreadId, before, limit]
      );
      const data = r.rows.map(messageFrom);
      return { data, page: { next_cursor: data.length === limit ? data.at(-1)!.message_id : null } };
    }

    if (isRootOnly) {
      const r = await app.pg.query(
        `SELECT m.*, COALESCE(rep.reply_count, 0) AS reply_count, rep.last_reply_at
         FROM messages m
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS reply_count, MAX(created_at) AS last_reply_at
           FROM messages r WHERE r.root_message_id = m.id
         ) rep ON true
         WHERE m.room_id = $1 AND m.root_message_id IS NULL
           AND ($2::text IS NULL OR (m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $2))
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $3`,
        [roomId, before, limit]
      );
      const data = r.rows.map(messageFrom);
      return { data, page: { next_cursor: data.length === limit ? data.at(-1)!.message_id : null } };
    }

    const r = await app.pg.query(
      `SELECT m.* FROM messages m
       WHERE m.room_id = $1 AND ($2::text IS NULL OR (m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $2))
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $3`,
      [roomId, before, limit]
    );
    const data = r.rows.map(messageFrom);
    return { data, page: { next_cursor: data.length === limit ? data.at(-1)!.message_id : null } };
  });
  function messageFrom(x:any){
    const tags = Array.isArray(x.tags)
      ? x.tags
      : (typeof x.tags === "string" ? JSON.parse(x.tags) : (x.tags ?? []));
    return {
      message_id: x.id,
      room_id: x.room_id,
      sender: { actor_type: x.sender_type, actor_id: x.sender_id, display_name: x.sender_name },
      sender_type: x.sender_type,
      sender_id: x.sender_id,
      sender_name: x.sender_name,
      recipient_agent_id: x.recipient_agent_id,
      reply_to_message_id: x.reply_to_message_id,
      root_message_id: x.root_message_id ?? null,
      ...(x.reply_count !== undefined ? { reply_count: Number(x.reply_count) } : {}),
      ...(x.last_reply_at !== undefined ? { last_reply_at: x.last_reply_at } : {}),
      category: x.category ?? null,
      tags,
      status: x.status ?? "open",
      resolved_at: x.resolved_at ?? null,
      body: x.body,
      created_at: x.created_at
    };
  }
  app.get("/v1/messages/:messageId",async(req,reply)=>{if(!await principal(req,reply))return;const r=await app.pg.query("SELECT * FROM messages WHERE id=$1",[(req.params as any).messageId]);if(!r.rowCount)return fail(reply,404,"not_found","Message not found");return{data:messageFrom(r.rows[0])}});
  app.post("/v1/rooms/:roomId/messages",async(req,reply)=>{
    const p=await principal(req,reply);if(!p)return;
    const actorKey=`${p.type}:${p.id}`;
    const b=req.body as any;

    let category: string | null = null;
    let tags: string[] = [];

    if (b.category !== undefined && b.category !== null) {
      if (b.reply_to_message_id) {
        return fail(reply, 400, "reply_cannot_have_category", "Replies cannot define category or thread metadata");
      }
      const validCategories = ["question", "discussion", "task_proposal", "review_request"];
      if (!validCategories.includes(b.category)) {
        return fail(reply, 400, "invalid_category", "Invalid category. Allowed: question, discussion, task_proposal, review_request");
      }
      category = b.category;

      if (b.tags !== undefined && b.tags !== null) {
        if (!Array.isArray(b.tags)) {
          return fail(reply, 400, "invalid_tags", "Tags must be an array of strings");
        }
        if (b.tags.length > 10) {
          return fail(reply, 400, "invalid_tags", "A maximum of 10 tags is allowed");
        }
        const tagRegex = /^[a-z0-9-_]+$/;
        for (const t of b.tags) {
          if (typeof t !== "string") {
            return fail(reply, 400, "invalid_tags", "Each tag must be a string");
          }
          const norm = t.trim().toLowerCase();
          if (norm.length < 1 || norm.length > 50 || !tagRegex.test(norm)) {
            return fail(reply, 400, "invalid_tags", "Each tag must be 1-50 characters matching ^[a-z0-9-_]+$");
          }
          tags.push(norm);
        }
      }
    } else if (b.tags !== undefined && b.tags !== null) {
      if (b.reply_to_message_id) {
        return fail(reply, 400, "reply_cannot_have_category", "Replies cannot define category or thread metadata");
      }
      if (!Array.isArray(b.tags)) {
        return fail(reply, 400, "invalid_tags", "Tags must be an array of strings");
      }
      if (b.tags.length > 10) {
        return fail(reply, 400, "invalid_tags", "A maximum of 10 tags is allowed");
      }
      const tagRegex = /^[a-z0-9-_]+$/;
      for (const t of b.tags) {
        if (typeof t !== "string") {
          return fail(reply, 400, "invalid_tags", "Each tag must be a string");
        }
        const norm = t.trim().toLowerCase();
        if (norm.length < 1 || norm.length > 50 || !tagRegex.test(norm)) {
          return fail(reply, 400, "invalid_tags", "Each tag must be 1-50 characters matching ^[a-z0-9-_]+$");
        }
        tags.push(norm);
      }
    }

    return idem(req,reply,actorKey,async()=>{
      const mid=id("msg"),rid=(req.params as any).roomId,idemKey=String(req.headers["idempotency-key"]),client=await app.pg.connect();
      try{
        await client.query("BEGIN");
        if(p.type==="agent")await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`spam:${p.id}`]);
        // Row-level idempotency: a replay (even after its idempotency_keys record is gone) is never counted or rejected.
        const replay=(await client.query("SELECT 1 FROM messages WHERE idempotency_actor=$1 AND idempotency_key=$2",[actorKey,idemKey])).rowCount;
        if(!replay)await enforceQuota(client,limits,p,messageClassOf({recipient_agent_id:b.recipient_agent_id,reply_to_message_id:b.reply_to_message_id,category}),{recipientAgentId:b.recipient_agent_id});

        let rootMessageId: string | null = null;
        // Only the owner case is tracked past this point: an agent root author is already covered by
        // room_members (posting the root auto-joined them), but owners can never be room members, so
        // without this a thread an owner started would go silent on them the moment someone replied.
        let rootOwnerAuthorId: string | null = null;

        if (b.reply_to_message_id) {
          const parentRes = await client.query(
            "SELECT id, room_id, root_message_id, sender_type, sender_id FROM messages WHERE id = $1",
            [b.reply_to_message_id]
          );
          if (!parentRes.rowCount) {
            await client.query("ROLLBACK");
            return fail(reply, 404, "not_found", "Parent message not found");
          }
          const parent = parentRes.rows[0];
          if (parent.room_id !== rid) {
            await client.query("ROLLBACK");
            return fail(reply, 400, "bad_request", "Cannot reply to a message in a different room");
          }

          if (parent.root_message_id === null) {
            rootMessageId = parent.id;
            if (parent.sender_type === "owner") rootOwnerAuthorId = parent.sender_id;
          } else {
            rootMessageId = parent.root_message_id;
            const rootRes = await client.query(
              "SELECT sender_type, sender_id FROM messages WHERE id = $1",
              [rootMessageId]
            );
            if (!rootRes.rowCount) {
              await client.query("ROLLBACK");
              return fail(reply, 404, "not_found", "Thread root message not found");
            }
            if (rootRes.rows[0].sender_type === "owner") rootOwnerAuthorId = rootRes.rows[0].sender_id;
          }
        }

        const r = await client.query(
          `INSERT INTO messages(id, room_id, sender_type, sender_id, sender_name, recipient_agent_id, reply_to_message_id, root_message_id, body, idempotency_actor, idempotency_key, category, tags, status, resolved_at, created_at)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, clock_timestamp())
           ON CONFLICT(idempotency_actor, idempotency_key) WHERE idempotency_key IS NOT NULL
           DO UPDATE SET id=messages.id
           WHERE messages.reply_to_message_id IS NOT DISTINCT FROM EXCLUDED.reply_to_message_id
             AND messages.recipient_agent_id IS NOT DISTINCT FROM EXCLUDED.recipient_agent_id
             AND messages.body = EXCLUDED.body
           RETURNING *`,
          [mid, rid, p.type, p.id, p.name, b.recipient_agent_id ?? null, b.reply_to_message_id ?? null, rootMessageId, b.body, actorKey, idemKey, category, JSON.stringify(tags), "open", null]
        );
        if (!r.rowCount) {
          await client.query("ROLLBACK");
          return fail(reply, 409, "idempotency_conflict", "Idempotency key was used with a different message body, reply_to, or recipient");
        }

        const inserted = r.rows[0].id === mid;
        if (inserted) {
          // W1 (issue #36): posting is how an agent joins a room's membership — idempotent, same transaction as the message.
          if (p.type === "agent") {
            await client.query("INSERT INTO room_members(room_id,agent_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [rid, p.id]);
          }
          // A room message is not private just because it names someone (README: "direct addressing is
          // not private messaging"), so the fan-out always runs — sender and, if set, the addressee are
          // excluded here so the addressee's own event (below) is the only one they get, not two.
          await client.query(
            `INSERT INTO inbox_events(id,agent_id,type,resource_kind,resource_id)
             SELECT 'evt_'||replace(gen_random_uuid()::text,'-',''), rm.agent_id, 'message.created', 'message', $1
             FROM room_members rm
             WHERE rm.room_id=$2 AND rm.agent_id IS DISTINCT FROM $3 AND rm.agent_id IS DISTINCT FROM $4`,
            [mid, rid, p.type === "agent" ? p.id : null, b.recipient_agent_id ?? null]
          );
          if (b.recipient_agent_id) {
            await client.query("INSERT INTO inbox_events(id,agent_id,type,resource_kind,resource_id) VALUES($1,$2,'message.created','message',$3)", [id("evt"), b.recipient_agent_id, mid]);
          }
          // Thread root author who is an owner: never a room member, so not reachable by the fan-out above.
          if (rootOwnerAuthorId && rootOwnerAuthorId !== p.id) {
            await client.query("INSERT INTO inbox_events(id,owner_id,type,resource_kind,resource_id) VALUES($1,$2,'message.created','message',$3)", [id("evt"), rootOwnerAuthorId, mid]);
          }
          // W2 (issue #36): a root forum message (category set, root_message_id null — the same
          // shape GET /v1/forum/threads selects) also reaches agents who never joined the room,
          // via their tag subscriptions. One INSERT...SELECT DISTINCT: an agent subscribed to
          // several of this message's tags still gets exactly one event, not one per tag match.
          if (category !== null && tags.length) {
            await client.query(
              `INSERT INTO inbox_events(id,agent_id,type,resource_kind,resource_id,payload)
               SELECT 'evt_'||replace(gen_random_uuid()::text,'-',''), d.agent_id, 'forum.thread', 'message', $1, $2::jsonb
               FROM (SELECT DISTINCT agent_id FROM agent_subscriptions WHERE tag=ANY($3::text[]) AND agent_id IS DISTINCT FROM $4) d`,
              [
                mid,
                JSON.stringify({
                  message_id: mid,
                  room_id: rid,
                  category,
                  tags,
                  topic: b.body.length > 140 ? `${b.body.slice(0, 140)}…` : b.body,
                  author: { actor_type: p.type, actor_id: p.id, display_name: p.name }
                }),
                tags,
                p.type === "agent" ? p.id : null
              ]
            );
          }
        }

        if(inserted&&p.type==="agent"){
          const repeats=Number((await client.query("SELECT count(*) n FROM messages WHERE sender_type='agent' AND sender_id=$1 AND body=$2 AND created_at>now()-interval '60 seconds'",[p.id,b.body])).rows[0].n);
          if(repeats===Number(process.env.SPAM_REPEAT_THRESHOLD??5)){
            const reportId=id("rpt"),incidentId=id("inc");
            await client.query("INSERT INTO reports VALUES($1,'platform','moderation_watcher','message',$2,'spam',$3,'escalated',now(),now())",[reportId,mid,`Repeated identical message ${repeats} times within 60 seconds`]);
            await client.query("INSERT INTO incidents(id,report_id,owner_id,agent_id) VALUES($1,$2,$3,$4)",[incidentId,reportId,p.ownerId,p.id]);
            await client.query("INSERT INTO inbox_events(id,owner_id,type,resource_kind,resource_id) VALUES($1,$2,'moderation.updated','incident',$3)",[id("evt"),p.ownerId,incidentId]);
          }
        }
        await client.query("UPDATE rooms SET updated_at=now() WHERE id=$1",[rid]);
        await client.query("COMMIT");
        return{status:201,data:messageFrom(r.rows[0])};
      }catch(e){
        await client.query("ROLLBACK");
        throw e;
      }finally{
        client.release();
      }
    });
  });

  /** W1 (issue #36): explicit membership, so agents can join a room to listen without posting. Idempotent. */
  async function roomMembershipChange(req: FastifyRequest, reply: any, p: Principal, work: (client: Db) => Promise<unknown>) {
    if (req.headers["idempotency-key"] !== undefined) {
      return idem(req, reply, `${p.type}:${p.id}`, async client => ({ status: 200, data: await work(client) }));
    }
    return { data: await work(app.pg) };
  }
  app.post("/v1/rooms/:roomId/members", async (req, reply) => {
    const p = await principal(req, reply, ["session", "agent"]);
    if (!p) return;
    if (p.type !== "agent") return fail(reply, 403, "agent_only", "Only agents can join rooms");
    const roomId = (req.params as any).roomId;
    if (!(await app.pg.query("SELECT 1 FROM rooms WHERE id=$1", [roomId])).rowCount) {
      return fail(reply, 404, "not_found", "Room not found");
    }
    return roomMembershipChange(req, reply, p, async client => {
      await client.query("INSERT INTO room_members(room_id,agent_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [roomId, p.id]);
      const row = (await client.query("SELECT joined_at FROM room_members WHERE room_id=$1 AND agent_id=$2", [roomId, p.id])).rows[0];
      return { room_id: roomId, agent_id: p.id, joined_at: row.joined_at };
    });
  });
  app.delete("/v1/rooms/:roomId/members/me", async (req, reply) => {
    const p = await principal(req, reply, ["session", "agent"]);
    if (!p) return;
    if (p.type !== "agent") return fail(reply, 403, "agent_only", "Only agents can leave rooms");
    const roomId = (req.params as any).roomId;
    return roomMembershipChange(req, reply, p, async client => {
      await client.query("DELETE FROM room_members WHERE room_id=$1 AND agent_id=$2", [roomId, p.id]);
      return { room_id: roomId, agent_id: p.id, left: true };
    });
  });

  app.get("/v1/forum/threads", async (req, reply) => {
    const p = await principal(req, reply, ["owner", "session", "agent"]);
    if (!p) return;
    const q = req.query as any;
    const limit = boundedLimit(q.limit);
    const status = q.status ?? "open";
    const validStatuses = ["open", "resolved", "closed", "all"];
    if (!validStatuses.includes(status)) {
      return fail(reply, 400, "invalid_status", "Status must be open, resolved, closed, or all");
    }
    const tag = q.tag ? String(q.tag).trim().toLowerCase() : null;
    const category = q.category ? String(q.category) : null;
    const roomId = q.room_id ?? q.room ?? null;
    const cursor = q.cursor ? String(q.cursor) : null;

    const r = await app.pg.query(
      `SELECT m.id, m.room_id, r.title AS room_title, m.sender_type, m.sender_id, m.sender_name,
              m.category, m.tags, m.status, m.resolved_at, m.body, m.created_at,
              COALESCE(rep.reply_count, 0)::int AS reply_count,
              rep.last_reply_at
       FROM messages m
       JOIN rooms r ON r.id = m.room_id
       LEFT JOIN agents ca ON r.creator_type = 'agent' AND ca.id = r.creator_id
       LEFT JOIN owners co ON (r.creator_type = 'owner' AND co.id = r.creator_id) OR co.id = ca.owner_id
       LEFT JOIN agents ma ON m.sender_type = 'agent' AND ma.id = m.sender_id
       LEFT JOIN owners mo ON (m.sender_type = 'owner' AND mo.id = m.sender_id) OR mo.id = ma.owner_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS reply_count, MAX(created_at) AS last_reply_at
         FROM messages sub WHERE sub.root_message_id = m.id
       ) rep ON true
       WHERE m.root_message_id IS NULL
         AND m.category IS NOT NULL
         AND r.is_public = true
         AND (
           (r.creator_type = 'owner' AND (co.restricted = false OR (co.restricted_until IS NOT NULL AND co.restricted_until <= now())))
           OR
           (r.creator_type = 'agent' AND (ca.restricted = false OR (ca.restricted_until IS NOT NULL AND ca.restricted_until <= now()))
                                     AND (co.restricted = false OR (co.restricted_until IS NOT NULL AND co.restricted_until <= now())))
         )
         AND (
           (m.sender_type = 'owner' AND (mo.restricted = false OR (mo.restricted_until IS NOT NULL AND mo.restricted_until <= now())))
           OR
           (m.sender_type = 'agent' AND (ma.restricted = false OR (ma.restricted_until IS NOT NULL AND ma.restricted_until <= now()))
                                    AND (mo.restricted = false OR (mo.restricted_until IS NOT NULL AND mo.restricted_until <= now())))
         )
         AND ($1::text IS NULL OR m.tags @> jsonb_build_array($1::text))
         AND ($2::text IS NULL OR m.category = $2)
         AND ($3::text = 'all' OR m.status = $3)
         AND ($4::text IS NULL OR m.room_id = $4)
         AND ($5::text IS NULL OR (m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $5))
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $6`,
      [tag, category, status, roomId, cursor, limit]
    );

    const data = r.rows.map((row) => {
      const tags = Array.isArray(row.tags)
        ? row.tags
        : (typeof row.tags === "string" ? JSON.parse(row.tags) : []);
      return {
        thread_id: row.id,
        message_id: row.id,
        room_id: row.room_id,
        room_title: row.room_title,
        author: {
          type: row.sender_type,
          id: row.sender_id,
          name: row.sender_name
        },
        category: row.category,
        tags,
        status: row.status,
        resolved_at: row.resolved_at,
        reply_count: Number(row.reply_count),
        last_reply_at: row.last_reply_at,
        body: row.body,
        created_at: row.created_at
      };
    });

    return {
      data,
      page: { next_cursor: data.length === limit ? data.at(-1)!.thread_id : null }
    };
  });

  app.patch("/v1/rooms/:roomId/messages/:messageId/status", async (req, reply) => {
    const p = await principal(req, reply, ["owner", "session", "agent"]);
    if (!p) return;
    const { roomId, messageId } = req.params as any;
    const b = req.body as any;
    const targetStatus = b?.status;

    const validStatuses = ["open", "resolved", "closed"];
    if (!targetStatus || !validStatuses.includes(targetStatus)) {
      return fail(reply, 400, "invalid_status", "Status must be open, resolved, or closed");
    }

    const msgRes = await app.pg.query(
      `SELECT m.id, m.room_id, m.sender_type, m.sender_id, m.category, m.root_message_id, m.status, m.tags, m.resolved_at,
              r.creator_type, r.creator_id,
              ca.owner_id AS room_creator_agent_owner_id,
              sa.owner_id AS sender_agent_owner_id
       FROM messages m
       JOIN rooms r ON r.id = m.room_id
       LEFT JOIN agents ca ON r.creator_type = 'agent' AND ca.id = r.creator_id
       LEFT JOIN agents sa ON m.sender_type = 'agent' AND sa.id = m.sender_id
       WHERE m.id = $1 AND m.room_id = $2`,
      [messageId, roomId]
    );

    if (!msgRes.rowCount) {
      return fail(reply, 404, "message_not_found", "Message not found in the specified room");
    }

    const msg = msgRes.rows[0];
    if (!msg.category || msg.root_message_id !== null) {
      return fail(reply, 400, "not_a_root_thread", "Message is not a root forum thread");
    }

    const currentStatus = msg.status;
    if (currentStatus !== targetStatus) {
      const allowedTransitions: Record<string, string[]> = {
        open: ["resolved", "closed"],
        resolved: ["open", "closed"],
        closed: ["open"]
      };
      if (!allowedTransitions[currentStatus]?.includes(targetStatus)) {
        return fail(reply, 400, "invalid_status_transition", `Cannot transition from ${currentStatus} to ${targetStatus}`);
      }
    }

    const isAuthor =
      (msg.sender_type === p.type && msg.sender_id === p.id) ||
      (p.type === "owner" && msg.sender_type === "agent" && msg.sender_agent_owner_id === p.id);

    const isRoomOwner =
      (msg.creator_type === "owner" && msg.creator_id === p.ownerId) ||
      (msg.creator_type === "agent" && (msg.creator_id === p.id || msg.room_creator_agent_owner_id === p.ownerId));

    if (!isAuthor && !isRoomOwner) {
      return fail(reply, 403, "unauthorized", "Only the thread author or room creator can change thread status");
    }

    const resolvedAt = targetStatus === "open" ? null : new Date().toISOString();
    const updateRes = await app.pg.query(
      "UPDATE messages SET status = $1, resolved_at = $2 WHERE id = $3 RETURNING *",
      [targetStatus, resolvedAt, messageId]
    );
    const updated = updateRes.rows[0];
    const tags = Array.isArray(updated.tags)
      ? updated.tags
      : (typeof updated.tags === "string" ? JSON.parse(updated.tags) : []);

    return {
      data: {
        message_id: updated.id,
        room_id: updated.room_id,
        category: updated.category,
        tags,
        status: updated.status,
        resolved_at: updated.resolved_at,
        updated_at: updated.resolved_at ?? new Date().toISOString()
      }
    };
  });

  /**
   * One PUT or DELETE is one `subscription_change`, counted in quota_events under the quota lock. With an Idempotency-Key the
   * change runs inside idem(), so a replay is served from the stored response and never counted twice.
   */
  async function subscriptionChange(req: FastifyRequest, reply: any, p: Principal, work: (client: PoolClient) => Promise<unknown>) {
    const run = async (client: PoolClient) => {
      await enforceQuota(client, limits, p, "subscription_change");
      const data = await work(client);
      await recordQuotaEvent(client, p, "subscription_change");
      return { status: 200, data };
    };
    if (req.headers["idempotency-key"] !== undefined) return idem(req, reply, `${p.type}:${p.id}`, run);
    const client = await app.pg.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return { data: result.data };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  app.get("/v1/agents/me/subscriptions", async (req, reply) => {
    const p = await principal(req, reply, ["session", "agent"]);
    if (!p) return;
    if (p.type !== "agent") return fail(reply, 403, "agent_only", "Only agents have topic subscriptions");
    const r = await app.pg.query(
      "SELECT tag, created_at FROM agent_subscriptions WHERE agent_id = $1 ORDER BY tag ASC",
      [p.id]
    );
    return {
      data: {
        agent_id: p.id,
        tags: r.rows.map(x => x.tag),
        created_at: r.rows[0]?.created_at ?? new Date().toISOString()
      }
    };
  });

  app.put("/v1/agents/me/subscriptions", async (req, reply) => {
    const p = await principal(req, reply, ["session", "agent"]);
    if (!p) return;
    if (p.type !== "agent") return fail(reply, 403, "agent_only", "Only agents have topic subscriptions");
    const b = req.body as any;
    if (!b || !Array.isArray(b.tags)) {
      return fail(reply, 400, "invalid_tags", "Tags must be an array of strings");
    }
    if (b.tags.length > 50) {
      return fail(reply, 400, "invalid_tags", "A maximum of 50 subscription tags is allowed");
    }
    const tagRegex = /^[a-z0-9-_]+$/;
    const normalizedTags: string[] = [];
    const seen = new Set<string>();
    for (const t of b.tags) {
      if (typeof t !== "string") {
        return fail(reply, 400, "invalid_tags", "Each tag must be a string");
      }
      const norm = t.trim().toLowerCase();
      if (norm.length < 1 || norm.length > 50 || !tagRegex.test(norm)) {
        return fail(reply, 400, "invalid_tags", "Each tag must be 1-50 characters matching ^[a-z0-9-_]+$");
      }
      if (!seen.has(norm)) {
        seen.add(norm);
        normalizedTags.push(norm);
      }
    }

    return subscriptionChange(req, reply, p, async client => {
      await client.query("DELETE FROM agent_subscriptions WHERE agent_id = $1", [p.id]);
      for (const tag of normalizedTags) {
        await client.query(
          "INSERT INTO agent_subscriptions(agent_id, tag) VALUES($1, $2)",
          [p.id, tag]
        );
      }
      return { agent_id: p.id, tags: normalizedTags };
    });
  });

  app.delete("/v1/agents/me/subscriptions/:tag", async (req, reply) => {
    const p = await principal(req, reply, ["session", "agent"]);
    if (!p) return;
    if (p.type !== "agent") return fail(reply, 403, "agent_only", "Only agents have topic subscriptions");
    const rawTag = (req.params as any).tag;
    const tag = String(rawTag).trim().toLowerCase();
    return subscriptionChange(req, reply, p, async client => {
      await client.query("DELETE FROM agent_subscriptions WHERE agent_id = $1 AND tag = $2", [p.id, tag]);
      return { removed: true, tag };
    });
  });
  async function eventsFor(p:Principal,after:number,limit:number){const col=p.type==="agent"?"agent_id":"owner_id";const r=await app.pg.query(`SELECT * FROM inbox_events WHERE ${col}=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`,[p.id,after,limit]);return r.rows.map(x=>({event_id:x.id,cursor:cursorOf(x.sequence),type:x.type,occurred_at:x.occurred_at,resource:{kind:x.resource_kind,id:x.resource_id},data:x.payload??null}))}
  app.get("/v1/inbox/events",async(req,reply)=>{const p=await principal(req,reply);if(!p)return;const q=req.query as any,data=await eventsFor(p,cursorFrom(q.after_cursor),boundedLimit(q.limit));return{data,page:{next_cursor:data.length?data.at(-1)!.cursor:null}}});
  // W2 (issue #36): this filter set had drifted from bootstrapFor's — "knowledge" only ever
  // matched knowledge.reviewed (which nothing produced before now), and task/forum types were
  // not bucketed at all. Kept in sync with bootstrapFor's counts so the two never disagree again.
  app.get("/v1/inbox/overview",async(req,reply)=>{const p=await principal(req,reply);if(!p)return;const col=p.type==="agent"?"agent_id":"owner_id",checkpoint=Number((await app.pg.query("SELECT coalesce((SELECT sequence FROM inbox_checkpoints WHERE actor_type=$1 AND actor_id=$2),0) n",[p.type,p.id])).rows[0].n),max=Number((await app.pg.query(`SELECT coalesce(max(sequence),0) n FROM inbox_events WHERE ${col}=$1`,[p.id])).rows[0].n),latest=await eventsFor(p,Math.max(0,max-10),10),pending=await eventsFor(p,checkpoint,100);return{data:{cursor:cursorOf(max),pending_counts:{messages:pending.filter(x=>x.type==="message.created").length,moderation:pending.filter(x=>x.type==="moderation.updated").length,tasks:pending.filter(x=>x.type==="task.changed"||x.type==="task.cancelled").length,forum:pending.filter(x=>x.type==="forum.thread").length,knowledge:pending.filter(x=>x.type==="knowledge.reviewed"||x.type==="knowledge.published").length,rooms:pending.filter(x=>x.type==="room.goal_changed").length},latest}}});
  app.post("/v1/inbox/cursors",async(req,reply)=>{const p=await principal(req,reply);if(!p)return;const cursor=(req.body as any).cursor,sequence=cursorFrom(cursor);await app.pg.query("INSERT INTO inbox_checkpoints VALUES($1,$2,$3,now()) ON CONFLICT(actor_type,actor_id) DO UPDATE SET sequence=greatest(inbox_checkpoints.sequence,excluded.sequence),saved_at=now()",[p.type,p.id,sequence]);return{data:{cursor,saved_at:now()}}});

  function normalizeEvidence(items: unknown): Array<{ kind: "message" | "url" | "task" | "fact"; uri: string; excerpt?: string; observed_at?: string }> {
    if (!Array.isArray(items)) return [];
    return items.map(item => {
      if (!item) return null;
      if (typeof item === "string") return { kind: "fact" as const, uri: item };
      if (typeof item === "object") {
        const obj = item as Record<string, any>;
        const uri = obj.uri ?? obj.url ?? obj.id_or_url;
        if (!uri || typeof uri !== "string") return null;
        let kind: "message" | "url" | "task" | "fact" = "fact";
        if (["message", "url", "task", "fact"].includes(obj.kind)) {
          kind = obj.kind;
        } else if (obj.url || obj.kind === "url") {
          kind = "url";
        }
        const res: { kind: "message" | "url" | "task" | "fact"; uri: string; excerpt?: string; observed_at?: string } = { kind, uri };
        const excerpt = obj.excerpt ?? obj.title;
        if (typeof excerpt === "string" && excerpt.length > 0) res.excerpt = excerpt.slice(0, 1000);
        const observed = obj.observed_at ?? obj.accessed_at;
        if (typeof observed === "string" && observed.length > 0) res.observed_at = observed;
        return res;
      }
      return null;
    }).filter((x): x is NonNullable<typeof x> => x !== null);
  }

  function buildKnowledgeFilters(p: Principal, q: any, startIdx: number) {
    const clauses: string[] = [];
    const params: any[] = [];
    let idx = startIdx;

    let authorClause: string;
    if (p.type === "owner") {
      params.push(p.id);
      authorClause = `c.author_agent_id IN (SELECT id FROM agents WHERE owner_id = $${idx++})`;
    } else {
      params.push(p.id);
      authorClause = `c.author_agent_id = $${idx++}`;
    }

    if (q.scope === "mine") {
      clauses.push(authorClause);
    } else if (q.scope === "public") {
      clauses.push(`c.public = true`);
    } else {
      clauses.push(`(c.public = true OR ${authorClause})`);
    }

    if (q.include_archived !== "true") {
      clauses.push(`c.archived = false`);
    }

    if (q.include_refuted !== "true") {
      const threshold = Number(process.env.CONFIRMATION_THRESHOLD ?? 2);
      const indRefutesSubquery = `(
        SELECT count(DISTINCT a_rev.owner_id)
        FROM knowledge_reviews kr
        JOIN agents a_rev ON a_rev.id = kr.reviewer_agent_id
        JOIN owners o_rev ON o_rev.id = a_rev.owner_id
        JOIN agents a_auth ON a_auth.id = v.author_agent_id
        WHERE kr.version_id = v.id
          AND kr.verdict = 'refute'
          AND a_rev.owner_id <> a_auth.owner_id
          AND NOT (a_rev.restricted = true AND (a_rev.restricted_until IS NULL OR a_rev.restricted_until > now()))
          AND NOT (o_rev.restricted = true AND (o_rev.restricted_until IS NULL OR o_rev.restricted_until > now()))
      )`;
      const indConfirmsSubquery = `(
        SELECT count(DISTINCT a_rev.owner_id)
        FROM knowledge_reviews kr
        JOIN agents a_rev ON a_rev.id = kr.reviewer_agent_id
        JOIN owners o_rev ON o_rev.id = a_rev.owner_id
        JOIN agents a_auth ON a_auth.id = v.author_agent_id
        WHERE kr.version_id = v.id
          AND kr.verdict = 'confirm'
          AND a_rev.owner_id <> a_auth.owner_id
          AND NOT (a_rev.restricted = true AND (a_rev.restricted_until IS NULL OR a_rev.restricted_until > now()))
          AND NOT (o_rev.restricted = true AND (o_rev.restricted_until IS NULL OR o_rev.restricted_until > now()))
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_reviews kr2
            JOIN agents a2 ON a2.id = kr2.reviewer_agent_id
            WHERE kr2.version_id = v.id
              AND kr2.verdict = 'refute'
              AND a2.owner_id = a_rev.owner_id
          )
      )`;
      clauses.push(
        `NOT ((NOT EXISTS (SELECT 1 FROM knowledge_versions kv WHERE kv.card_id = c.id AND kv.confirmed_at IS NOT NULL)) AND (${indRefutesSubquery} >= ${threshold} AND ${indRefutesSubquery} > ${indConfirmsSubquery}))`
      );
    }

    return { clauses, params, nextIdx: idx };
  }

  async function getReviewMetrics(versionId: string, clientOrPool: Pool | PoolClient = app.pg) {
    const threshold = Number(process.env.CONFIRMATION_THRESHOLD ?? 2);
    const versionRes = await clientOrPool.query(
      "SELECT id, confirmed_at FROM knowledge_versions WHERE id = $1",
      [versionId]
    );
    const confirmedAt = versionRes.rows[0]?.confirmed_at ?? null;

    const res = await clientOrPool.query(
      `SELECT
        kr.verdict,
        a_reviewer.owner_id AS reviewer_owner_id,
        a_author.owner_id AS author_owner_id,
        (a_reviewer.restricted = true AND (a_reviewer.restricted_until IS NULL OR a_reviewer.restricted_until > now())) AS reviewer_agent_restricted,
        (o_reviewer.restricted = true AND (o_reviewer.restricted_until IS NULL OR o_reviewer.restricted_until > now())) AS reviewer_owner_restricted
      FROM knowledge_reviews kr
      JOIN knowledge_versions v ON v.id = kr.version_id
      JOIN agents a_reviewer ON a_reviewer.id = kr.reviewer_agent_id
      JOIN owners o_reviewer ON o_reviewer.id = a_reviewer.owner_id
      JOIN agents a_author ON a_author.id = v.author_agent_id
      WHERE kr.version_id = $1`,
      [versionId]
    );

    return evaluateReviewQuorum(res.rows, threshold, confirmedAt);
  }

  async function versionFrom(versionId: string) {
    const v = (await app.pg.query(
      `SELECT v.*,
              c.challenge_card_id,
              c.challenge_version_id,
              EXISTS(SELECT 1 FROM knowledge_cards x WHERE x.challenge_version_id = v.id) AS has_challenges
       FROM knowledge_versions v
       JOIN knowledge_cards c ON c.id = v.card_id
       WHERE v.id = $1`,
      [versionId]
    )).rows[0];
    if (!v) return null;

    const metrics = await getReviewMetrics(versionId);

    return {
      version_id: v.id,
      card_id: v.card_id,
      version: v.version,
      topic: v.topic,
      summary: v.summary,
      body: v.body,
      sources: v.sources,
      references: v.refs,
      author_agent_id: v.author_agent_id,
      status: metrics.status,
      has_challenges: v.has_challenges,
      review_counts: metrics.raw,
      independent_review_counts: metrics.independent,
      quorum: metrics.quorum,
      confirmed_at: v.confirmed_at,
      created_at: v.created_at
    };
  }

  async function cardFrom(cardId: string) {
    const c = (await app.pg.query("SELECT * FROM knowledge_cards WHERE id = $1", [cardId])).rows[0];
    if (!c) return null;
    const challenges = await app.pg.query(
      "SELECT id, latest_version_id FROM knowledge_cards WHERE challenge_card_id = $1 AND challenge_version_id IS NOT NULL",
      [cardId]
    );

    const canonicalRow = (await app.pg.query(
      "SELECT id, version FROM knowledge_versions WHERE card_id = $1 AND confirmed_at IS NOT NULL ORDER BY version DESC, created_at DESC LIMIT 1",
      [cardId]
    )).rows[0];
    const canonical_version_id = canonicalRow?.id ?? null;

    const latest = c.latest_version_id ? await versionFrom(c.latest_version_id) : null;

    let status: "unconfirmed" | "confirmed" | "refuted" | "archived" = "unconfirmed";
    if (c.archived) {
      status = "archived";
    } else if (canonical_version_id) {
      status = "confirmed";
    } else if (latest?.status === "refuted") {
      status = "refuted";
    } else {
      status = "unconfirmed";
    }

    const has_pending_proposal = Boolean(
      canonical_version_id && c.latest_version_id !== canonical_version_id && latest?.status === "unconfirmed"
    );
    const has_refuted_proposal = Boolean(
      canonical_version_id && c.latest_version_id !== canonical_version_id && latest?.status === "refuted"
    );

    return {
      card_id: c.id,
      author_agent_id: c.author_agent_id,
      latest_version_id: c.latest_version_id,
      canonical_version_id,
      has_pending_proposal,
      has_refuted_proposal,
      public: c.public,
      archived: Boolean(c.archived),
      status,
      review_counts: latest?.review_counts ?? { confirm: 0, refute: 0, comment: 0 },
      challenge_of: c.challenge_card_id ? { card_id: c.challenge_card_id, version_id: c.challenge_version_id } : null,
      challenged_by: challenges.rows.map(x => ({ card_id: x.id, latest_version_id: x.latest_version_id })),
      created_at: c.created_at,
      latest
    };
  }

  app.post("/v1/knowledge/cards",async(req,reply)=>{
    const p=await principal(req,reply,["session"]);
    if(!p)return;
    return idem(req,reply,p.id,async()=>{
      const b=req.body as any,cid=id("knw"),vid=id("knv");
      if(b.challenge_of){
        const target=await app.pg.query("SELECT 1 FROM knowledge_versions WHERE id=$1 AND card_id=$2",[b.challenge_of.version_id,b.challenge_of.card_id]);
        if(!target.rowCount)throw Object.assign(new Error("challenge target"),{statusCode:422});
      }
      const client=await app.pg.connect();
      try{
        await client.query("BEGIN");
        await enforceQuota(client,limits,p,"knowledge_card");
        await client.query("INSERT INTO knowledge_cards(id,author_agent_id,challenge_card_id,challenge_version_id,created_at) VALUES($1,$2,$3,$4,clock_timestamp())",[cid,p.id,b.challenge_of?.card_id??null,b.challenge_of?.version_id??null]);
        const sourcesJson=JSON.stringify(normalizeEvidence(b.sources));
        const refsJson=JSON.stringify(normalizeEvidence(b.references));
        await client.query("INSERT INTO knowledge_versions VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,NULL,clock_timestamp())",[vid,cid,b.topic,b.summary,b.body,sourcesJson,refsJson,p.id]);
        await client.query("UPDATE knowledge_cards SET latest_version_id=$2 WHERE id=$1",[cid,vid]);
        await client.query("COMMIT");
      }catch(e){
        await client.query("ROLLBACK");
        throw e;
      }finally{
        client.release();
      }
      await indexVersion(vid,`${b.topic}\n${b.summary}\n${b.body}`);
      return{status:201,data:await cardFrom(cid)};
    });
  });

  app.patch("/v1/knowledge/cards/:cardId/public",async(req,reply)=>{
    const p=await principal(req,reply,["owner"]);
    if(!p)return;
    const cid=(req.params as any).cardId,b=req.body as {public:boolean};
    const card=(await app.pg.query("SELECT c.author_agent_id,c.public,v.topic FROM knowledge_cards c LEFT JOIN knowledge_versions v ON v.id=c.latest_version_id WHERE c.id=$1",[cid])).rows[0];
    if(!card)return fail(reply,404,"not_found","Card not found");
    if(!await ownsAgent(p,card.author_agent_id))return fail(reply,403,"forbidden","Only the author owner can change publication");
    const client=await app.pg.connect();
    try{
      await client.query("BEGIN");
      const r=await client.query("UPDATE knowledge_cards SET public=$2 WHERE id=$1 RETURNING id,public",[cid,b.public]);
      // W2 (issue #36): only the false->true transition is "reaching published state" — flipping
      // an already-public card (or unpublishing) must not re-notify. Author + every reviewer of
      // any of its versions, actor excluded, deduplicated via UNION (not UNION ALL) so a reviewer
      // of three versions still gets exactly one event.
      if(b.public&&!card.public){
        await client.query(
          `INSERT INTO inbox_events(id,agent_id,type,resource_kind,resource_id,payload)
           SELECT 'evt_'||replace(gen_random_uuid()::text,'-',''), recipient, 'knowledge.published', 'knowledge_card', $1, $2::jsonb
           FROM (
             SELECT $3::text AS recipient
             UNION
             SELECT kr.reviewer_agent_id FROM knowledge_reviews kr JOIN knowledge_versions kv ON kv.id=kr.version_id WHERE kv.card_id=$1
           ) recipients
           WHERE recipient IS DISTINCT FROM $4`,
          [cid, JSON.stringify({card_id:cid,topic:card.topic,published_by:{actor_type:p.type,actor_id:p.id}}), card.author_agent_id, p.type==="agent"?p.id:null]
        );
      }
      await client.query("COMMIT");
      return{data:{card_id:r.rows[0].id,public:r.rows[0].public}};
    }catch(e){
      await client.query("ROLLBACK");
      throw e;
    }finally{
      client.release();
    }
  });

  app.patch("/v1/knowledge/cards/:cardId/archive",async(req,reply)=>{
    const p=await principal(req,reply,["owner","session"]);
    if(!p)return;
    const cid=(req.params as any).cardId,b=req.body as {archived:boolean};
    const card=(await app.pg.query("SELECT author_agent_id FROM knowledge_cards WHERE id=$1",[cid])).rows[0];
    if(!card)return fail(reply,404,"not_found","Card not found");
    if(!await ownsAgent(p,card.author_agent_id))return fail(reply,403,"forbidden","Only the author agent or owner can change archival status");
    const r=await app.pg.query("UPDATE knowledge_cards SET archived=$2 WHERE id=$1 RETURNING id,archived",[cid,b.archived]);
    return{data:{card_id:r.rows[0].id,archived:r.rows[0].archived}};
  });

  app.get("/v1/knowledge/cards",async(req,reply)=>{
    const p=await principal(req,reply);
    if(!p)return;
    const q=req.query as any,status=await embeddingStatus(),limit=boundedLimit(q.limit);
    if(q.search==="semantic"&&status.status==="unavailable")return fail(reply,503,"embedding_unavailable","Semantic search unavailable");
    let rows:any[]=[];
    let ranked=false;
    if(q.q&&(q.search==="semantic"||q.search==="hybrid")){
      const vector=await embeddings.embed(q.q);
      if(vector){
        ranked=true;
        const filter=buildKnowledgeFilters(p,q,2);
        const whereSql=filter.clauses.length?`WHERE ${filter.clauses.join(" AND ")}`:"";
        rows=(await app.pg.query(
          `SELECT c.id FROM knowledge_embeddings e JOIN knowledge_versions v ON v.id=e.version_id JOIN knowledge_cards c ON c.latest_version_id=v.id ${whereSql} ORDER BY e.embedding <=> $1::vector LIMIT $${filter.nextIdx}`,
          [`[${vector.join(",")}]`,...filter.params,limit]
        )).rows;
      }else if(q.search==="semantic")return fail(reply,503,"embedding_unavailable","Semantic search unavailable");
    }
    if(!rows.length){
      ranked=false;
      const term=q.q?`%${q.q}%`:null,before=q.before_cursor?String(q.before_cursor):null;
      const filter=buildKnowledgeFilters(p,q,3);
      const allClauses=[
        `($1::text IS NULL OR v.topic ILIKE $1 OR v.summary ILIKE $1 OR v.body ILIKE $1)`,
        `($2::text IS NULL OR (c.created_at,c.id)<(SELECT created_at,id FROM knowledge_cards WHERE id=$2))`,
        ...filter.clauses
      ];
      rows=(await app.pg.query(
        `SELECT c.id FROM knowledge_cards c JOIN knowledge_versions v ON v.id=c.latest_version_id WHERE ${allClauses.join(" AND ")} ORDER BY c.created_at DESC,c.id DESC LIMIT $${filter.nextIdx}`,
        [term,before,...filter.params,limit]
      )).rows;
    }
    const data=await Promise.all(rows.map(x=>cardFrom(x.id)));
    return{data,page:{next_cursor:!ranked&&data.length===limit?data.at(-1)!.card_id:null},search_status:{semantic:status.status}};
  });

  app.get("/v1/knowledge/cards/:cardId",async(req,reply)=>{
    const p=await principal(req,reply);
    if(!p)return;
    const cid=(req.params as any).cardId;
    const card=(await app.pg.query("SELECT author_agent_id, public FROM knowledge_cards WHERE id=$1",[cid])).rows[0];
    if(!card)return fail(reply,404,"not_found","Card not found");
    if(!card.public&&!(await ownsAgent(p,card.author_agent_id)))return fail(reply,404,"not_found","Card not found");
    const data=await cardFrom(cid);
    return{data};
  });

  app.post("/v1/knowledge/cards/:cardId/versions",async(req,reply)=>{
    const p=await principal(req,reply,["session"]);
    if(!p)return;
    const cid=(req.params as any).cardId,b=req.body as any,key=String(req.headers["idempotency-key"]),requestHash=bodyHash({method:req.method,path:req.url.split("?")[0],body:req.body});
    const prior=(await app.pg.query("SELECT id,idempotency_body_hash FROM knowledge_versions WHERE author_agent_id=$1 AND idempotency_key=$2",[p.id,key])).rows[0];
    if(prior){
      if(prior.idempotency_body_hash!==requestHash)return fail(reply,409,"idempotency_conflict","Key was used with a different body");
      return reply.code(201).send({data:await versionFrom(prior.id)});
    }
    return idem(req,reply,p.id,async()=>{
      const vid=id("knv"),client=await app.pg.connect();
      try{
        await client.query("BEGIN");
        const c=(await client.query("SELECT * FROM knowledge_cards WHERE id=$1 FOR UPDATE",[cid])).rows[0];
        if(!c)throw Object.assign(new Error("Card not found"),{statusCode:404});
        if(c.author_agent_id!==p.id)throw Object.assign(new Error("Only author can version"),{statusCode:403});
        if(c.latest_version_id!==b.expected_latest_version_id)throw Object.assign(new Error("Latest version changed"),{statusCode:409});
        // Row-level idempotency: an existing (author, key) version is a replay and is never counted.
        if(!(await client.query("SELECT 1 FROM knowledge_versions WHERE author_agent_id=$1 AND idempotency_key=$2",[p.id,key])).rowCount)await enforceQuota(client,limits,p,"knowledge_version");
        const n=Number((await client.query("SELECT coalesce(max(version),0)+1 n FROM knowledge_versions WHERE card_id=$1",[cid])).rows[0].n);
        const sourcesJson=JSON.stringify(normalizeEvidence(b.sources));
        const refsJson=JSON.stringify(normalizeEvidence(b.references));
        await client.query("INSERT INTO knowledge_versions(id,card_id,version,topic,summary,body,sources,refs,author_agent_id,idempotency_key,idempotency_body_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())",[vid,cid,n,b.topic,b.summary,b.body,sourcesJson,refsJson,p.id,key,requestHash]);
        const changed=await client.query("UPDATE knowledge_cards SET latest_version_id=$3 WHERE id=$1 AND latest_version_id=$2",[cid,b.expected_latest_version_id,vid]);
        if(changed.rowCount!==1)throw Object.assign(new Error("Latest version changed"),{statusCode:409});
        await client.query("COMMIT");
      }catch(e){
        await client.query("ROLLBACK");
        throw e;
      }finally{
        client.release();
      }
      await indexVersion(vid,`${b.topic}\n${b.summary}\n${b.body}`);
      return{status:201,data:await versionFrom(vid)};
    });
  });

  app.get("/v1/knowledge/cards/:cardId/versions",async(req,reply)=>{
    const p=await principal(req,reply);
    if(!p)return;
    const cid=(req.params as any).cardId;
    const card=(await app.pg.query("SELECT author_agent_id, public FROM knowledge_cards WHERE id=$1",[cid])).rows[0];
    if(!card)return fail(reply,404,"not_found","Card not found");
    if(!card.public&&!(await ownsAgent(p,card.author_agent_id)))return fail(reply,404,"not_found","Card not found");
    const q=req.query as any,limit=boundedLimit(q.limit),before=q.before_cursor?String(q.before_cursor):null;
    const r=await app.pg.query(`SELECT v.id FROM knowledge_versions v WHERE v.card_id=$1 AND ($2::text IS NULL OR v.version<(SELECT version FROM knowledge_versions WHERE id=$2 AND card_id=$1)) ORDER BY v.version DESC LIMIT $3`,[cid,before,limit]);
    const data=await Promise.all(r.rows.map(x=>versionFrom(x.id)));
    return{data,page:{next_cursor:data.length===limit?data.at(-1)!.version_id:null}};
  });

  app.get("/v1/knowledge/versions/:versionId",async(req,reply)=>{
    const p=await principal(req,reply);
    if(!p)return;
    const vid=(req.params as any).versionId;
    const data=await versionFrom(vid);
    if(!data)return fail(reply,404,"not_found","Version not found");
    return{data};
  });

  app.post("/v1/knowledge/versions/:versionId/reviews",async(req,reply)=>{
    const p=await principal(req,reply,["session"]);
    if(!p)return;
    const vid=(req.params as any).versionId;
    const target=(await app.pg.query("SELECT card_id,topic,author_agent_id FROM knowledge_versions WHERE id=$1",[vid])).rows[0];
    if(!target)return fail(reply,404,"not_found","Version not found");
    return idem(req,reply,p.id,async()=>{
      const b=req.body as any,client=await app.pg.connect();
      let r:any;
      try{
        await client.query("BEGIN");
        await enforceQuota(client,limits,p,"knowledge_review");
        const evidenceJson=JSON.stringify(normalizeEvidence(b.evidence));
        const existing=(await client.query("SELECT * FROM knowledge_reviews WHERE version_id=$1 AND reviewer_agent_id=$2 FOR UPDATE",[vid,p.id])).rows[0];
        if(existing){
          await client.query("INSERT INTO knowledge_review_revisions(review_id,revision,verdict,explanation,evidence,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[existing.id,existing.revision,existing.verdict,existing.explanation,JSON.stringify(existing.evidence),existing.created_at]);
          r=(await client.query("UPDATE knowledge_reviews SET verdict=$3,explanation=$4,evidence=$5,revision=revision+1,created_at=clock_timestamp() WHERE version_id=$1 AND reviewer_agent_id=$2 RETURNING *",[vid,p.id,b.verdict,b.explanation,evidenceJson])).rows[0];
        }else{
          r=(await client.query("INSERT INTO knowledge_reviews(id,version_id,reviewer_agent_id,verdict,explanation,evidence,created_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) RETURNING *",[id("rev"),vid,p.id,b.verdict,b.explanation,evidenceJson])).rows[0];
        }
        // W2 (issue #36): a review verdict was previously silent for the card's author.
        if(target.author_agent_id!==p.id){
          await client.query(
            "INSERT INTO inbox_events(id,agent_id,type,resource_kind,resource_id,payload) VALUES($1,$2,'knowledge.reviewed','knowledge_version',$3,$4::jsonb)",
            [id("evt"),target.author_agent_id,vid,JSON.stringify({version_id:vid,card_id:target.card_id,topic:target.topic,verdict:r.verdict,reviewer_agent_id:p.id})]
          );
        }
        const metrics = await getReviewMetrics(vid, client);
        if (metrics.independent.confirm >= metrics.threshold) {
          await client.query("UPDATE knowledge_versions SET confirmed_at = coalesce(confirmed_at, now()) WHERE id = $1", [vid]);
        }
        await client.query("COMMIT");
      }catch(e){
        await client.query("ROLLBACK");
        throw e;
      }finally{
        client.release();
      }
      return{status:201,data:{review_id:r.id,version_id:vid,reviewer_agent_id:p.id,verdict:r.verdict,explanation:r.explanation,evidence:r.evidence,revision:r.revision,created_at:r.created_at}};
    });
  });
  app.get("/v1/knowledge/versions/:versionId/reviews/:reviewId/history",async(req,reply)=>{if(!await principal(req,reply))return;const x=req.params as any;const current=(await app.pg.query("SELECT * FROM knowledge_reviews WHERE id=$1 AND version_id=$2",[x.reviewId,x.versionId])).rows[0];if(!current)return fail(reply,404,"not_found","Review not found");const old=(await app.pg.query("SELECT revision,verdict,explanation,evidence,created_at FROM knowledge_review_revisions WHERE review_id=$1 ORDER BY revision",[x.reviewId])).rows;return{data:[...old,{revision:current.revision,verdict:current.verdict,explanation:current.explanation,evidence:current.evidence,created_at:current.created_at}],page:{next_cursor:null}}});
  app.get("/v1/knowledge/versions/:versionId/reviews",async(req,reply)=>{if(!await principal(req,reply))return;const r=await app.pg.query("SELECT id review_id,version_id,reviewer_agent_id,verdict,explanation,evidence,created_at FROM knowledge_reviews WHERE version_id=$1 ORDER BY created_at DESC LIMIT $2",[(req.params as any).versionId,boundedLimit((req.query as any).limit)]);return{data:r.rows,page:{next_cursor:null}}});

  const taskFrom=(x:any)=>({task_id:x.id,room_id:x.room_id,creator:{actor_type:x.creator_type,actor_id:x.creator_id,display_name:x.creator_name},assigned_agent_id:x.assigned_agent_id,title:x.title,description:x.description,status:x.status,result:x.result,created_at:x.created_at,updated_at:x.updated_at});
  const TERMINAL_TASK=["completed","failed","cancelled"];
  const byOf=(p:Principal)=>({actor_type:p.type,actor_id:p.id});
  async function taskEvent(db:Db,recipient:{type:string;id:string},type:string,taskId:string,payload:Record<string,unknown>){const col=recipient.type==="agent"?"agent_id":"owner_id";await db.query(`INSERT INTO inbox_events(id,${col},type,resource_kind,resource_id,payload) VALUES($1,$2,$3,'task',$4,$5)`,[id("evt"),recipient.id,type,taskId,JSON.stringify(payload)])}
  /** Assignee must exist, not be revoked or restricted (422), and have capacity (409); checked atomically under `agent:` lock (PRD §3.2.4). */
  app.post("/v1/rooms/:roomId/tasks",async(req,reply)=>{const p=await principal(req,reply);if(!p)return;return idem(req,reply,`${p.type}:${p.id}`,async client=>{
    const b=req.body as any,tid=id("tsk"),assignee=b.assigned_agent_id;
    const a=(await client.query(`SELECT a.revoked_at,${RESTRICTED_SQL("a")} AS agent_restricted,${RESTRICTED_SQL("o")} AS owner_restricted FROM agents a JOIN owners o ON o.id=a.owner_id WHERE a.id=$1`,[assignee])).rows[0];
    if(!a||a.revoked_at||a.agent_restricted||a.owner_restricted)throw new ApiError(422,"assignee_unavailable","The assignee does not exist, is revoked, or is restricted");
    await enforceQuota(client,limits,p,"task_create");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`agent:${assignee}`]);
    const cap=limits.capacity.open_tasks_per_assignee;
    if(cap>0&&Number((await client.query("SELECT count(*)::int n FROM tasks WHERE assigned_agent_id=$1 AND status<>ALL($2)",[assignee,TERMINAL_TASK])).rows[0].n)>=cap)throw new ApiError(409,"assignee_at_capacity",`The assignee already has ${cap} open tasks`,{limit:cap});
    const r=await client.query("WITH t AS (SELECT clock_timestamp() c) INSERT INTO tasks SELECT $1,$2,$3,$4,$5,$6,$7,$8,'proposed',NULL,t.c,t.c FROM t RETURNING *",[tid,(req.params as any).roomId,p.type,p.id,p.name,assignee,b.title,b.description]);
    // W2 (issue #36): task.changed was already the assignment signal — it just didn't carry the
    // task's title, so a recipient couldn't tell what it was about without a second request.
    await taskEvent(client,{type:"agent",id:assignee},"task.changed",tid,{by:byOf(p),status:"proposed",title:b.title});
    return{status:201,data:taskFrom(r.rows[0])}})});
  app.get("/v1/rooms/:roomId/tasks",async(req,reply)=>{if(!await principal(req,reply))return;const r=await app.pg.query("SELECT * FROM tasks WHERE room_id=$1 ORDER BY created_at DESC LIMIT $2",[(req.params as any).roomId,boundedLimit((req.query as any).limit)]);return{data:r.rows.map(taskFrom),page:{next_cursor:null}}});
  app.get("/v1/tasks/:taskId",async(req,reply)=>{if(!await principal(req,reply))return;const r=await app.pg.query("SELECT * FROM tasks WHERE id=$1",[(req.params as any).taskId]);if(!r.rowCount)return fail(reply,404,"not_found","Task not found");return{data:taskFrom(r.rows[0])}});
  /** Assignee status change; `cancelled` is a decline, allowed only from proposed/accepted. The creator gets `task.changed`. */
  app.patch("/v1/tasks/:taskId",async(req,reply)=>{const p=await principal(req,reply,["session"]);if(!p)return;const tid=(req.params as any).taskId,b=req.body as any;return idem(req,reply,p.id,async client=>{
    const t=(await client.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE",[tid])).rows[0];
    if(!t)throw new ApiError(404,"not_found","Task not found");
    if(t.assigned_agent_id!==p.id)throw new ApiError(403,"forbidden","Only assignee can update");
    if(TERMINAL_TASK.includes(t.status))throw new ApiError(409,"invalid_task_transition","Task is terminal");
    if(b.status==="cancelled"){
      if(!["proposed","accepted"].includes(t.status))throw new ApiError(409,"invalid_task_transition",`Cannot decline a task that is ${t.status}`);
      assertNoSecret([b.result]);
    }else if(!["accepted","in_progress","completed","failed"].includes(b.status))throw new ApiError(422,"validation_error","Invalid task status");
    const r=await client.query("UPDATE tasks SET status=$2,result=$3,updated_at=now() WHERE id=$1 RETURNING *",[tid,b.status,b.result??t.result]);
    // W2 (issue #36): title and previous_status so the creator can tell what changed without a
    // second request, instead of adding a second, duplicate event type for the same transition.
    if(!(t.creator_type==="agent"&&t.creator_id===p.id))await taskEvent(client,{type:t.creator_type,id:t.creator_id},"task.changed",tid,{by:byOf(p),status:b.status,title:t.title,previous_status:t.status});
    return{status:200,data:taskFrom(r.rows[0])}})});
  /** Creator cancel; the assignee receives a typed `task.cancelled` signal. */
  app.post("/v1/tasks/:taskId/cancel",async(req,reply)=>{const p=await principal(req,reply);if(!p)return;const tid=(req.params as any).taskId;return idem(req,reply,`${p.type}:${p.id}`,async client=>{
    const t=(await client.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE",[tid])).rows[0];
    if(!t)throw new ApiError(404,"not_found","Task not found");
    if(t.creator_type!==p.type||t.creator_id!==p.id)throw new ApiError(403,"forbidden","Only creator can cancel");
    if(TERMINAL_TASK.includes(t.status))throw new ApiError(409,"invalid_task_transition","Task is terminal");
    const r=await client.query("UPDATE tasks SET status='cancelled',updated_at=now() WHERE id=$1 RETURNING *",[tid]);
    if(!(p.type==="agent"&&p.id===t.assigned_agent_id))await taskEvent(client,{type:"agent",id:t.assigned_agent_id},"task.cancelled",tid,{by:byOf(p),status:"cancelled",title:t.title,previous_status:t.status});
    return{status:200,data:taskFrom(r.rows[0])}})});
  app.get("/v1/limits",async(req,reply)=>{if(!await principal(req,reply,["owner","session","agent"]))return;return{data:effective}});
  app.get("/v1/owners/me/usage",async(req,reply)=>{const p=await principal(req,reply,["owner"]);if(!p)return;return{data:await ownerUsage(app.pg,limits,p.id)}});
  app.get("/v1/agents/me/usage",async(req,reply)=>{const p=await principal(req,reply,["owner","session","agent"]);if(!p)return;if(p.type!=="agent")return fail(reply,403,"agent_only","Only agents have their own usage; owners use /v1/owners/me/usage");return{data:await agentUsage(app.pg,limits,p.id)}});
  app.get("/v1/recommendations",async(req,reply)=>{
    const p=await principal(req,reply,["session","agent","owner"]);
    if(!p)return;
    const q=req.query as any,kind=q.kind??"rooms",limit=boundedLimit(q.limit);
    if(kind==="threads"){
      const data=await recommendThreads(app.pg,p,limit);
      return{data};
    }
    const a=(await app.pg.query("SELECT interests FROM agents WHERE id=$1",[p.id])).rows[0],terms=((a?.interests as string[])??[]).map(x=>x.toLowerCase());
    let candidates:any[]=[];
    if(kind==="rooms")candidates=(await app.pg.query("SELECT r.id,r.title||' '||r.description text,(SELECT count(*) FROM messages m WHERE m.room_id=r.id AND (m.sender_id=$1 OR m.recipient_agent_id=$1)) history FROM rooms r ORDER BY r.updated_at DESC LIMIT 200",[p.id])).rows;
    if(kind==="knowledge")candidates=(await app.pg.query("SELECT c.id,v.topic||' '||v.summary text,(SELECT count(*) FROM knowledge_reviews kr WHERE kr.version_id=v.id AND kr.reviewer_agent_id=$1) history FROM knowledge_cards c JOIN knowledge_versions v ON v.id=c.latest_version_id ORDER BY c.created_at DESC LIMIT 200",[p.id])).rows;
    if(kind==="agents")candidates=(await app.pg.query("SELECT a.id,a.name||' '||a.role||' '||a.bio||' '||a.interests::text text,(SELECT count(*) FROM messages m WHERE (m.sender_id=$1 AND m.recipient_agent_id=a.id) OR (m.sender_id=a.id AND m.recipient_agent_id=$1)) history FROM agents a WHERE a.id<>$1 ORDER BY a.created_at DESC LIMIT 200",[p.id])).rows;
    const data=candidates.map(x=>{const hits=terms.filter(t=>String(x.text).toLowerCase().includes(t)),history=Number(x.history);return{kind,id:x.id,score:hits.length*2+Math.min(history,5),reason:[hits.length?`Matched interests: ${hits.join(", ")}`:null,history?`${history} prior interaction(s)`:null].filter(Boolean).join("; ")}}).filter(x=>x.score>0).sort((x,y)=>y.score-x.score).slice(0,limit);
    return{data};
  });

  app.post("/v1/reports", async (req, reply) => {
    const p = await principal(req, reply);
    if (!p) return;
    const ownerRes = await app.pg.query(
      "SELECT (restricted = true AND (restricted_until IS NULL OR restricted_until > now())) AS is_restricted FROM owners WHERE id = $1",
      [p.ownerId]
    );
    if (ownerRes.rows[0]?.is_restricted) {
      return fail(reply, 403, "restricted", "Reporter owner is restricted from filing reports");
    }
    return idem(req, reply, `${p.type}:${p.id}`, async client => {
      const b = req.body as any, rid = id("rpt"), iid = id("inc");
      await enforceQuota(client, limits, p, "report");
      let subject: any;
      if (b.target.kind === "profile") subject = (await app.pg.query("SELECT id agent_id,owner_id FROM agents WHERE id=$1", [b.target.id])).rows[0];
      if (b.target.kind === "message") subject = (await app.pg.query("SELECT CASE WHEN m.sender_type='agent' THEN a.id END agent_id,CASE WHEN m.sender_type='owner' THEN m.sender_id ELSE a.owner_id END owner_id FROM messages m LEFT JOIN agents a ON m.sender_type='agent' AND a.id=m.sender_id WHERE m.id=$1", [b.target.id])).rows[0];
      if (b.target.kind === "knowledge_version") subject = (await app.pg.query("SELECT a.id agent_id,a.owner_id FROM knowledge_versions v JOIN agents a ON a.id=v.author_agent_id WHERE v.id=$1", [b.target.id])).rows[0];
      if (!subject?.owner_id) return Promise.reject(Object.assign(new Error("Report target not found"), { statusCode: 422 }));
      // Self-report policy: owners reporting their own agents/content is explicitly supported as a valid self-escalation/safety-audit path (contract established in mvp.test.ts:206).

      const existingOpen = await app.pg.query(
        `SELECT 1 FROM reports r
         JOIN incidents i ON i.report_id = r.id
         WHERE r.reporter_type = $1
           AND r.reporter_id = $2
           AND r.target_kind = $3
           AND r.target_id = $4
           AND i.status NOT IN ('resolved')`,
        [p.type, p.id, b.target.kind, b.target.id]
      );
      if (existingOpen.rowCount) {
        return Promise.reject(Object.assign(new Error("An unresolved report already exists for this target"), { statusCode: 409 }));
      }

      const ownerId = subject.owner_id, agentId = subject.agent_id ?? null;
      await client.query("WITH t AS (SELECT clock_timestamp() c) INSERT INTO reports SELECT $1,$2,$3,$4,$5,$6,$7,'escalated',t.c,t.c FROM t", [rid, p.type, p.id, b.target.kind, b.target.id, b.category, b.explanation]);
      await client.query("INSERT INTO incidents(id,report_id,owner_id,agent_id) VALUES($1,$2,$3,$4)", [iid, rid, ownerId, agentId]);
      await client.query("INSERT INTO inbox_events(id,owner_id,type,resource_kind,resource_id) VALUES($1,$2,'moderation.updated','incident',$3)", [id("evt"), ownerId, iid]);
      return { status: 201, data: { report_id: rid, status: "escalated", created_at: now() } };
    });
  });
  app.get("/v1/reports/:reportId",async(req,reply)=>{const p=await principal(req,reply);if(!p)return;const r=await app.pg.query("SELECT * FROM reports WHERE id=$1 AND reporter_type=$2 AND reporter_id=$3",[(req.params as any).reportId,p.type,p.id]);if(!r.rowCount)return fail(reply,404,"not_found","Report not found");return{data:{report_id:r.rows[0].id,status:r.rows[0].status,updated_at:r.rows[0].updated_at}}});
  app.get("/v1/moderation/incidents",async(req,reply)=>{if(!isModerator(req,reply))return;const r=await app.pg.query("SELECT * FROM incidents ORDER BY created_at DESC LIMIT $1",[boundedLimit((req.query as any).limit)]);return{data:r.rows,page:{next_cursor:null}}});
  /** Restricts non-revoked agents only (a revoked agent is never un-revoked by a later expiry), ends their sessions and signals each one. */
  async function restrictAgents(client: PoolClient, where: { ownerId?: string; agentId?: string }, exp: any, kind: "temporary" | "permanent", incidentId: string) {
    const agents = (await client.query(
      `UPDATE agents SET restricted = true, restricted_until = $1, restriction_kind = $2 WHERE ${where.ownerId ? "owner_id" : "id"} = $3 AND revoked_at IS NULL RETURNING id, restricted_until`,
      [exp, kind, where.ownerId ?? where.agentId]
    )).rows;
    for (const a of agents) {
      await endAgentSessions(client, a.id, "restricted");
      await agentEvent(client, a.id, "agent.restricted", { restriction_kind: kind, restricted_until: a.restricted_until, incident_id: incidentId });
    }
  }
  async function applyOwnerRestriction(client: PoolClient, ownerId: string, exp: any, kind: "temporary" | "permanent", incidentId: string) {
    await client.query(
      "UPDATE owners SET restricted = true, restricted_until = $1, restriction_kind = $2 WHERE id = $3",
      [exp, kind, ownerId]
    );
    await restrictAgents(client, { ownerId }, exp, kind, incidentId);
  }

  app.patch("/v1/moderation/incidents/:incidentId", async (req, reply) => {
    if (!isModerator(req, reply)) return;
    const iid = (req.params as any).incidentId, b = req.body as any, client = await app.pg.connect();
    try {
      await client.query("BEGIN");
      const incident = (await client.query("SELECT * FROM incidents WHERE id=$1 FOR UPDATE", [iid])).rows[0];
      if (!incident) {
        await client.query("ROLLBACK");
        return fail(reply, 404, "not_found", "Incident not found");
      }
      if (incident.revision !== b.expected_revision) {
        await client.query("ROLLBACK");
        return fail(reply, 409, "stale_revision", "Incident revision is stale");
      }

      let nextStatus = b.status ?? incident.status;
      let nextAction = b.action ?? incident.action;
      let nextResolution = b.resolution ?? incident.resolution;
      let nextSanctionKind = incident.sanction_kind;
      let nextSanctionExpiresAt = incident.sanction_expires_at;
      let nextAppealStatus = incident.appeal_status;
      let nextAppealResolvedAt = incident.appeal_resolved_at;
      let nextAppealResolution = incident.appeal_resolution;

      if (b.action === "warn") {
        nextStatus = b.status ?? "resolved";
        nextAction = "warn";
        nextSanctionKind = "warning";
        nextSanctionExpiresAt = null;
      } else if (b.action === "restrict_agent_temporary") {
        if (!b.duration_sec || typeof b.duration_sec !== "number" || b.duration_sec <= 0) {
          await client.query("ROLLBACK");
          return fail(reply, 422, "invalid_duration", "duration_sec must be positive");
        }
        if (!incident.agent_id) {
          await client.query("ROLLBACK");
          return fail(reply, 422, "invalid_target", "Incident has no associated agent");
        }
        const expResult = await client.query("SELECT (now() + ($1 * interval '1 second')) AS exp", [b.duration_sec]);
        const exp = expResult.rows[0].exp;
        await restrictAgents(client, { agentId: incident.agent_id }, exp, "temporary", iid);
        nextStatus = b.status ?? "resolved";
        nextAction = "restrict_agent_temporary";
        nextSanctionKind = "temporary_restriction";
        nextSanctionExpiresAt = exp;
      } else if (b.action === "restrict_agent") {
        if (!incident.agent_id) {
          await client.query("ROLLBACK");
          return fail(reply, 422, "invalid_target", "Incident has no associated agent");
        }
        await restrictAgents(client, { agentId: incident.agent_id }, null, "permanent", iid);
        nextStatus = b.status ?? "resolved";
        nextAction = "restrict_agent";
        nextSanctionKind = "permanent_restriction";
        nextSanctionExpiresAt = null;
      } else if (b.action === "restrict_owner_temporary") {
        if (!b.duration_sec || typeof b.duration_sec !== "number" || b.duration_sec <= 0) {
          await client.query("ROLLBACK");
          return fail(reply, 422, "invalid_duration", "duration_sec must be positive");
        }
        if (!incident.owner_id) {
          await client.query("ROLLBACK");
          return fail(reply, 422, "invalid_target", "Incident has no associated owner");
        }
        const expResult = await client.query("SELECT (now() + ($1 * interval '1 second')) AS exp", [b.duration_sec]);
        const exp = expResult.rows[0].exp;
        await applyOwnerRestriction(client, incident.owner_id, exp, "temporary", iid);
        nextStatus = b.status ?? "resolved";
        nextAction = "restrict_owner_temporary";
        nextSanctionKind = "temporary_restriction";
        nextSanctionExpiresAt = exp;
      } else if (b.action === "restrict_owner") {
        if (!incident.owner_id) {
          await client.query("ROLLBACK");
          return fail(reply, 422, "invalid_target", "Incident has no associated owner");
        }
        await applyOwnerRestriction(client, incident.owner_id, null, "permanent", iid);
        nextStatus = b.status ?? "resolved";
        nextAction = "restrict_owner";
        nextSanctionKind = "permanent_restriction";
        nextSanctionExpiresAt = null;
      } else if (b.action === "grant_appeal") {
        nextStatus = b.status ?? "resolved";
        nextAction = "grant_appeal";
        nextAppealStatus = "granted";
        nextAppealResolvedAt = new Date().toISOString();
        nextAppealResolution = b.resolution ?? "Appeal granted";
        if (incident.action === "restrict_owner" || incident.action === "restrict_owner_temporary" || (!incident.agent_id && incident.owner_id)) {
          if (incident.owner_id) {
            await client.query(
              "UPDATE owners SET restricted = false, restricted_until = NULL, restriction_kind = NULL WHERE id = $1",
              [incident.owner_id]
            );
            await client.query(
              "UPDATE agents SET restricted = false, restricted_until = NULL, restriction_kind = NULL WHERE owner_id = $1 AND revoked_at IS NULL",
              [incident.owner_id]
            );
          }
        } else if (incident.agent_id) {
          await client.query(
            "UPDATE agents SET restricted = false, restricted_until = NULL, restriction_kind = NULL WHERE id = $1 AND revoked_at IS NULL",
            [incident.agent_id]
          );
        }
      } else if (b.action === "deny_appeal") {
        nextStatus = b.status ?? "resolved";
        nextAction = "deny_appeal";
        nextAppealStatus = "denied";
        nextAppealResolvedAt = new Date().toISOString();
        nextAppealResolution = b.resolution ?? "Appeal denied";
      } else if (b.action === "dismiss") {
        nextStatus = b.status ?? "resolved";
        nextAction = "none";
        nextResolution = b.resolution ?? "Dismissed";
      } else if (b.action === "dismiss_malicious") {
        nextStatus = b.status ?? "resolved";
        nextAction = "dismissed_malicious";
        nextResolution = b.resolution ?? "Dismissed as malicious report";

        const reportRow = (await client.query("SELECT * FROM reports WHERE id = $1", [incident.report_id])).rows[0];
        if (reportRow) {
          let reporterOwnerId: string | null = null;
          if (reportRow.reporter_type === "owner") {
            reporterOwnerId = reportRow.reporter_id;
          } else if (reportRow.reporter_type === "agent") {
            const ag = (await client.query("SELECT owner_id FROM agents WHERE id = $1", [reportRow.reporter_id])).rows[0];
            reporterOwnerId = ag?.owner_id ?? null;
          }
          if (reporterOwnerId) {
            // Lock reporter owner row to eliminate the race window on concurrent dismiss_malicious actions
            await client.query("SELECT id FROM owners WHERE id = $1 FOR UPDATE", [reporterOwnerId]);
            const priorRes = await client.query(
              `SELECT count(*)::int AS count
               FROM incidents i
               JOIN reports r ON r.id = i.report_id
               WHERE i.action = 'dismissed_malicious'
                 AND i.id != $1
                 AND (
                   (r.reporter_type = 'owner' AND r.reporter_id = $2)
                   OR
                   (r.reporter_type = 'agent' AND r.reporter_id IN (SELECT id FROM agents WHERE owner_id = $2))
                 )`,
              [iid, reporterOwnerId]
            );
            const priorCount = priorRes.rows[0].count;
            if (priorCount === 0) {
              await client.query(
                "INSERT INTO inbox_events(id, owner_id, type, resource_kind, resource_id) VALUES($1, $2, 'moderation.updated', 'incident', $3)",
                [id("evt"), reporterOwnerId, iid]
              );
            } else {
              const expResult = await client.query("SELECT (now() + interval '24 hours') AS exp");
              const exp = expResult.rows[0].exp;
              await applyOwnerRestriction(client, reporterOwnerId, exp, "temporary", iid);
              await client.query(
                "INSERT INTO inbox_events(id, owner_id, type, resource_kind, resource_id) VALUES($1, $2, 'moderation.updated', 'incident', $3)",
                [id("evt"), reporterOwnerId, iid]
              );
            }
          }
        }
      }

      const r = await client.query(
        `UPDATE incidents
         SET status = $2,
             action = $3,
             resolution = $4,
             sanction_kind = $5,
             sanction_expires_at = $6,
             appeal_status = $7,
             appeal_resolved_at = $8,
             appeal_resolution = $9,
             revision = revision + 1,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          iid,
          nextStatus,
          nextAction,
          nextResolution,
          nextSanctionKind,
          nextSanctionExpiresAt,
          nextAppealStatus,
          nextAppealResolvedAt,
          nextAppealResolution
        ]
      );
      // Deduplicate inbox_event: if reporter is same as incident owner, dismiss_malicious already emitted event above
      let penaltyEmittedToOwner = false;
      if (b.action === "dismiss_malicious") {
        const reportRow = (await client.query("SELECT * FROM reports WHERE id = $1", [incident.report_id])).rows[0];
        let repOwnerId = reportRow?.reporter_type === "owner" ? reportRow.reporter_id : null;
        if (reportRow?.reporter_type === "agent") {
          repOwnerId = (await client.query("SELECT owner_id FROM agents WHERE id = $1", [reportRow.reporter_id])).rows[0]?.owner_id ?? null;
        }
        if (repOwnerId && repOwnerId === incident.owner_id) {
          penaltyEmittedToOwner = true;
        }
      }
      if (incident.owner_id && !penaltyEmittedToOwner) {
        await client.query(
          "INSERT INTO inbox_events(id, owner_id, type, resource_kind, resource_id) VALUES($1, $2, 'moderation.updated', 'incident', $3)",
          [id("evt"), incident.owner_id, iid]
        );
      }
      await client.query("COMMIT");
      return { data: r.rows[0] };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });

  app.setErrorHandler((error:any,request,reply)=>{request.log.error({err:{message:error.message,code:error.code}},"request failed");if(error instanceof ApiError||error instanceof MemoryError){for(const [k,v] of Object.entries(error.headers??{}))reply.header(k,v);return fail(reply,error.status,error.code,error.message,error.details!==undefined?{details:error.details}:undefined)}if(error.statusCode===409||error.message==="duplicate")return fail(reply,409,"conflict","Resource already exists");if(error.statusCode===422)return fail(reply,422,"validation_error","Domain validation failed");if(error.code==="23503")return fail(reply,422,"invalid_reference","Referenced object does not exist");return fail(reply,error.statusCode??500,error.statusCode?"request_error":"internal_error",error.statusCode?error.message:"Internal server error")});
  return app;
}
