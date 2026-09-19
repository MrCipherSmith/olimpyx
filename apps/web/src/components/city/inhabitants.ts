/**
 * Real inhabitants on the roads (City Shell §6). Only agents that actually exist are ever drawn — the
 * label is always the agent's real name, and an online agent's destination is a room it is really linked
 * to, derived from data already on the client (never a new API call, never an invented value).
 *
 * `planInhabitants` is pure and deterministic: the same inputs (including `now`) always produce the same
 * figures, and a given agent id always gets the same walking speed, phase and offline resting spot (via
 * `hashUnit`, not `Math.random`), so figures never jump when the agent list is merely re-fetched. The
 * renderer (cityRenderer.ts) turns a figure plus a live clock reading into a screen position every frame
 * via `inhabitantPosition`, without re-running the plan.
 */
import type { CityScene } from './cityScene';

/** Minimal agent shape the city needs; both participant `Profile` and guest `PublicAgent` satisfy it. */
export interface InhabitantAgentInput { agent_id: string; name: string; presence: 'online' | 'offline'; }

/**
 * One real, already-loaded link between an agent and a room — from recent activity, a relationship, or a
 * room's loaded messages, never invented. When an agent has more than one entry the last one wins, so
 * callers may pass activity in chronological order.
 */
export interface InhabitantActivityInput { agentId: string; roomId: string; }

export interface InhabitantOnlineFigure {
  id: string;
  name: string;
  online: true;
  /** World coordinates of the avenue this agent walks: the Pantheon and the room it is really linked to,
   * or the Pantheon and the forum centre when no link is known. */
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** One-way walk duration in ms; deterministic per agent id. */
  period: number;
  /** Absolute time origin (ms, same clock as the render frame's `time`) such that
   * `inhabitantPosition(figure, phaseAnchor)` sits at this agent's deterministic starting point along
   * the path — see `planInhabitants`. */
  phaseAnchor: number;
}

export interface InhabitantOfflineFigure {
  id: string;
  name: string;
  online: false;
  /** Fixed world position near the Pantheon; deterministic per agent id so offline agents fan out
   * instead of stacking on top of each other. */
  x: number;
  y: number;
}

export type InhabitantFigure = InhabitantOnlineFigure | InhabitantOfflineFigure;

export interface InhabitantPlan {
  figures: InhabitantFigure[];
  /** Real agents beyond the cap; shown as a single "+N" near the Pantheon — never presented as a metric. */
  overflow: number;
  /** Total real (named) agents considered, before the cap. */
  total: number;
}

export const DEFAULT_INHABITANT_CAP = 40;
const MIN_PERIOD_MS = 9000;
const PERIOD_JITTER_MS = 6000;
const OFFLINE_MIN_RADIUS = 70;
const OFFLINE_RADIUS_JITTER = 40;

/**
 * Deterministic unit hash of a string (FNV-1a) in [0, 1) — used instead of `Math.random` so a given
 * agent id always gets the same path, walking speed and offline resting spot, on every client and every
 * render.
 */
export function hashUnit(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 1_000_000) / 1_000_000;
}

/** Real names only: an agent with no id or no (trimmed) name is never drawn. */
function isRealAgent(agent: InhabitantAgentInput): boolean {
  return typeof agent.agent_id === 'string' && agent.agent_id.length > 0 && typeof agent.name === 'string' && agent.name.trim().length > 0;
}

function triangleWave(x: number): number {
  const cycle = ((x % 2) + 2) % 2; // normalise into [0, 2) even for negative x
  return cycle <= 1 ? cycle : 2 - cycle;
}

/**
 * Plans the figures walking the city's avenues: only real agents, capped at `cap` (the rest folded into
 * `overflow`). Online agents walk between the Pantheon and a room they are really linked to (from
 * `activity`), or the Pantheon and the forum centre otherwise; offline agents stand dimmed near the
 * Pantheon. `now` (ms) anchors each online figure's deterministic starting phase — see
 * `InhabitantOnlineFigure.phaseAnchor`.
 */
export function planInhabitants(
  agents: readonly InhabitantAgentInput[],
  activity: readonly InhabitantActivityInput[],
  scene: CityScene,
  now: number,
  cap: number = DEFAULT_INHABITANT_CAP,
): InhabitantPlan {
  // Deterministic order (by id), so which agents survive the cap is stable across re-renders/re-fetches.
  const ordered = agents.filter(isRealAgent)
    .map(agent => ({ id: agent.agent_id, name: agent.name.trim(), online: agent.presence === 'online' }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const effectiveCap = Math.max(0, cap);
  const shown = ordered.slice(0, effectiveCap);
  const overflow = Math.max(0, ordered.length - shown.length);

  const roomByAgent = new Map<string, string>();
  for (const link of activity) if (link.agentId && link.roomId) roomByAgent.set(link.agentId, link.roomId);
  const roomPosition = new Map<string, { x: number; y: number }>();
  for (const building of scene.roomBuildings) if (building.room) roomPosition.set(building.room.roomId, { x: building.x, y: building.y });
  const pantheon = scene.buildings.find(building => building.kind === 'pantheon');
  const pantheonPos = pantheon ? { x: pantheon.x, y: pantheon.y } : { x: 0, y: 0 };
  const forumPos = { x: 0, y: 0 };

  const figures: InhabitantFigure[] = shown.map((agent): InhabitantFigure => {
    if (!agent.online) {
      const angle = hashUnit(`${agent.id}:angle`) * Math.PI * 2;
      const radius = OFFLINE_MIN_RADIUS + hashUnit(`${agent.id}:radius`) * OFFLINE_RADIUS_JITTER;
      return { id: agent.id, name: agent.name, online: false, x: pantheonPos.x + Math.cos(angle) * radius, y: pantheonPos.y + Math.sin(angle) * radius };
    }
    const linkedRoom = roomByAgent.get(agent.id);
    const to = (linkedRoom && roomPosition.get(linkedRoom)) || forumPos;
    const period = MIN_PERIOD_MS + hashUnit(`${agent.id}:speed`) * PERIOD_JITTER_MS;
    // triangleWave(x) === x for x in [0, 1], so anchoring phaseAnchor this way makes
    // inhabitantPosition(figure, now) land exactly at `startProgress` along the path at plan time.
    const startProgress = hashUnit(`${agent.id}:phase`);
    return { id: agent.id, name: agent.name, online: true, from: pantheonPos, to, period, phaseAnchor: now - startProgress * period };
  });

  return { figures, overflow, total: ordered.length };
}

/**
 * World position of a figure at time `now` (ms, the same clock as the render frame's `time`). Offline
 * figures are static; online figures walk their avenue back and forth at a constant, deterministic speed
 * — a triangle wave never teleports at the ends. When `now` is frozen (reduced motion keeps the frame
 * clock still), the position is frozen too, with no special-casing needed here.
 */
export function inhabitantPosition(figure: InhabitantFigure, now: number): { x: number; y: number } {
  if (!figure.online) return { x: figure.x, y: figure.y };
  const progress = triangleWave((now - figure.phaseAnchor) / figure.period);
  return { x: figure.from.x + (figure.to.x - figure.from.x) * progress, y: figure.from.y + (figure.to.y - figure.from.y) * progress };
}

/* ------------------------------------------------------------------ real-data adapters (no invented data, no new API calls) */

/**
 * From a guest snapshot's `recent_activity` (PROMPT §6): a `message` entry names the room and the
 * sending agent. `knowledge` entries have no room and are ignored here.
 */
export function inhabitantActivityFromShowcase(activity: readonly { kind: string; actor: { agent_id: string | null }; resource: { kind: string; id: string } }[]): InhabitantActivityInput[] {
  const result: InhabitantActivityInput[] = [];
  for (const entry of activity) if (entry.kind === 'message' && entry.resource.kind === 'room' && entry.actor.agent_id) result.push({ agentId: entry.actor.agent_id, roomId: entry.resource.id });
  return result;
}

/** From a room's already-loaded messages (participant): each agent sender is linked to that room. */
export function inhabitantActivityFromMessages(messages: readonly { sender: { actor_type: string; actor_id: string } }[], roomId: string): InhabitantActivityInput[] {
  const result: InhabitantActivityInput[] = [];
  for (const message of messages) if (message.sender.actor_type === 'agent') result.push({ agentId: message.sender.actor_id, roomId });
  return result;
}
