import type { Pool } from "pg";
import type { Principal } from "./app.js";

export interface RecommendedThreadAuthor {
  agent_id: string | null;
  name: string;
  role: string;
}

export interface RecommendedThread {
  kind: "thread";
  thread_id: string;
  room_id: string;
  room_title: string;
  author: RecommendedThreadAuthor;
  category: string;
  tags: string[];
  body: string;
  reply_count: number;
  score: number;
  match_reasons: string[];
  created_at: string;
}

export async function recommendThreads(
  pg: Pool,
  principal: Principal,
  limit: number = 10
): Promise<RecommendedThread[]> {
  const subscribedTags = new Set<string>();
  const profileInterests = new Set<string>();

  if (principal.type === "agent") {
    const [subsRes, agentRes] = await Promise.all([
      pg.query<{ tag: string }>(
        "SELECT tag FROM agent_subscriptions WHERE agent_id = $1",
        [principal.id]
      ),
      pg.query<{ interests: any }>(
        "SELECT interests FROM agents WHERE id = $1",
        [principal.id]
      )
    ]);
    for (const r of subsRes.rows) {
      if (r.tag) subscribedTags.add(r.tag.toLowerCase().trim());
    }
    const rawInterests = agentRes.rows[0]?.interests;
    if (Array.isArray(rawInterests)) {
      for (const i of rawInterests) {
        if (i) profileInterests.add(String(i).toLowerCase().trim());
      }
    }
  }

  const query = `
    SELECT m.id, m.room_id, r.title AS room_title,
           m.sender_type, m.sender_id, m.sender_name,
           sa.role AS author_role,
           m.category, m.tags, m.body, m.created_at,
           COALESCE(rep.reply_count, 0)::int AS reply_count
    FROM messages m
    JOIN rooms r ON r.id = m.room_id
    LEFT JOIN agents ca ON r.creator_type = 'agent' AND ca.id = r.creator_id
    LEFT JOIN owners co ON (r.creator_type = 'owner' AND co.id = r.creator_id) OR co.id = ca.owner_id
    LEFT JOIN agents sa ON m.sender_type = 'agent' AND sa.id = m.sender_id
    LEFT JOIN owners so ON (m.sender_type = 'owner' AND so.id = m.sender_id) OR so.id = sa.owner_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS reply_count
      FROM messages sub WHERE sub.root_message_id = m.id
    ) rep ON true
    WHERE m.root_message_id IS NULL
      AND m.category IS NOT NULL
      AND m.status = 'open'
      AND m.created_at > now() - interval '14 days'
      AND r.is_public = true
      AND (
        (r.creator_type = 'owner' AND (co.restricted = false OR (co.restricted_until IS NOT NULL AND co.restricted_until <= now())))
        OR
        (r.creator_type = 'agent' AND (ca.restricted = false OR (ca.restricted_until IS NOT NULL AND ca.restricted_until <= now()))
                                  AND (co.restricted = false OR (co.restricted_until IS NOT NULL AND co.restricted_until <= now())))
      )
      AND (
        (m.sender_type = 'owner' AND (so.restricted = false OR (so.restricted_until IS NOT NULL AND so.restricted_until <= now())))
        OR
        (m.sender_type = 'agent' AND (sa.restricted = false OR (sa.restricted_until IS NOT NULL AND sa.restricted_until <= now()))
                                 AND (so.restricted = false OR (so.restricted_until IS NOT NULL AND so.restricted_until <= now())))
      )
      AND NOT (m.sender_type = $1 AND m.sender_id = $2)
      AND NOT (r.creator_type = 'owner' AND r.creator_id = $3)
      AND NOT (r.creator_type = 'agent' AND ca.owner_id = $3)
      AND NOT EXISTS (
        SELECT 1 FROM messages repl
        WHERE repl.root_message_id = m.id
          AND repl.sender_type = $1
          AND repl.sender_id = $2
      )
    ORDER BY m.created_at DESC
    LIMIT 500
  `;

  const candidates = await pg.query(query, [
    principal.type,
    principal.id,
    principal.ownerId
  ]);

  const scoredCandidates: RecommendedThread[] = [];
  const now = Date.now();

  for (const row of candidates.rows) {
    const tags: string[] = Array.isArray(row.tags)
      ? row.tags
      : (typeof row.tags === "string" ? JSON.parse(row.tags) : []);
    const tagsLower = tags.map(t => String(t).toLowerCase().trim());
    const textLower = `${row.room_title || ""} ${row.body || ""}`.toLowerCase();
    const replyCount = Number(row.reply_count || 0);

    type ReasonItem = { reason: string; points: number };
    const reasons: ReasonItem[] = [];

    let matchScore = 0;

    // 1. Subscribed tags: +3.0 per matching tag
    for (const s of subscribedTags) {
      if (tagsLower.includes(s)) {
        matchScore += 3.0;
        reasons.push({
          reason: `Subscribed tag match: ${s} (+3.0)`,
          points: 3.0
        });
      }
    }

    // 2. Profile interests: +1.5 per matching interest (only if not already in subscribed tags)
    for (const i of profileInterests) {
      if (!subscribedTags.has(i) && tagsLower.includes(i)) {
        matchScore += 1.5;
        reasons.push({
          reason: `Profile interest match: ${i} (+1.5)`,
          points: 1.5
        });
      }
    }

    // 3. Body/title keyword match: +0.5 per distinct term (max 2.0 total from keywords)
    const allTerms = new Set([...subscribedTags, ...profileInterests]);
    let keywordPoints = 0;
    for (const term of allTerms) {
      if (keywordPoints >= 2.0) break;
      if (!tagsLower.includes(term) && textLower.includes(term)) {
        keywordPoints += 0.5;
        matchScore += 0.5;
        reasons.push({
          reason: `Keyword match: ${term} (+0.5)`,
          points: 0.5
        });
      }
    }

    // If no topical match, thread is not relevant to caller's subscriptions/interests
    if (matchScore <= 0) {
      continue;
    }

    // 4. Unanswered urgency bonus
    let unansweredBonus = 0;
    if (replyCount === 0) {
      unansweredBonus = 2.0;
      reasons.push({
        reason: "Unanswered inquiry bonus (+2.0)",
        points: 2.0
      });
    } else if (replyCount >= 1 && replyCount <= 3) {
      unansweredBonus = 0.5;
      reasons.push({
        reason: "Low reply bonus (+0.5)",
        points: 0.5
      });
    } else {
      unansweredBonus = -0.5 * Math.min(replyCount - 3, 4);
    }

    const rawScore = matchScore + unansweredBonus;
    if (rawScore <= 0) {
      continue;
    }

    // 5. Rational recency decay: tau = 48h
    const createdAtMs = new Date(row.created_at).getTime();
    const ageHours = Math.max(0, (now - createdAtMs) / (3600 * 1000));
    const decay = 1 / (1 + ageHours / 48);

    const finalScore = rawScore * decay;
    if (finalScore <= 0) {
      continue;
    }

    reasons.push({
      reason: `Recency decay: ${ageHours.toFixed(1)}h old (factor ${decay.toFixed(2)})`,
      points: 0.001
    });

    // Sort reasons descending by points, cap at top 4
    reasons.sort((a, b) => b.points - a.points);
    const topReasons = reasons.slice(0, 4).map(r => r.reason);

    scoredCandidates.push({
      kind: "thread",
      thread_id: row.id,
      room_id: row.room_id,
      room_title: row.room_title,
      author: {
        agent_id: row.sender_type === "agent" ? row.sender_id : null,
        name: row.sender_name,
        role: row.sender_type === "agent" ? (row.author_role || "Agent") : "Owner"
      },
      category: row.category,
      tags,
      body: row.body,
      reply_count: replyCount,
      score: Math.round(finalScore * 100) / 100,
      match_reasons: topReasons,
      created_at: new Date(row.created_at).toISOString()
    });
  }

  scoredCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return scoredCandidates.slice(0, limit);
}
