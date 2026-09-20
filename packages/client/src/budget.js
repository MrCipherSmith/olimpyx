// Local participation budget (PRD §3.4, D-045/Q-016). Optional `.olimpyx/budget.json`,
// enforced entirely on the client -- the server never sees it (D-021). Without a
// budget.json file, every function here is a no-op: behavior is unchanged (AC-9).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const BUDGET_FILE = 'budget.json';
const LEDGER_FILE = 'budget-ledger.json';
const HELP_MODES = ['on', 'contacts', 'off'];
const HOUR_MS = 60 * 60 * 1000;

export class OlimpyxBudgetExceededError extends Error {
  constructor(message, { limit, resetAt } = {}) {
    super(message);
    this.name = 'OlimpyxBudgetExceededError';
    this.code = 'OLIMPYX_BUDGET_EXCEEDED';
    this.limit = limit;
    this.resetAt = resetAt;
  }
}

export class OlimpyxHelpPolicyBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OlimpyxHelpPolicyBlockedError';
    this.code = 'OLIMPYX_HELP_POLICY_BLOCKED';
  }
}

async function readJsonOrNull(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicWriteJson(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

function normalizeBudget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const budget = {
    help: HELP_MODES.includes(raw.help) ? raw.help : 'on',
    contacts: Array.isArray(raw.contacts) ? raw.contacts.filter((c) => typeof c === 'string' && c) : []
  };
  if (raw.messages_per_hour !== undefined && raw.messages_per_hour !== null) {
    const n = Number(raw.messages_per_hour);
    if (Number.isFinite(n) && n > 0) budget.messages_per_hour = n;
  }
  if (raw.session_minutes !== undefined && raw.session_minutes !== null) {
    const n = Number(raw.session_minutes);
    if (Number.isFinite(n) && n > 0) budget.session_minutes = n;
  }
  return budget;
}

/** Returns the normalized local budget, or null when `.olimpyx/budget.json` doesn't exist. */
export async function loadBudget(root) {
  const raw = await readJsonOrNull(join(root, BUDGET_FILE));
  return normalizeBudget(raw);
}

/** Merges `patch` onto the existing (or default) budget and writes it back. */
export async function saveBudget(root, patch = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const current = (await loadBudget(root)) ?? { help: 'on', contacts: [] };
  const merged = { ...current, ...patch };
  if (patch.help === undefined) merged.help = current.help;
  if (patch.contacts === undefined) merged.contacts = current.contacts;
  const next = normalizeBudget(merged) ?? { help: 'on', contacts: [] };
  await atomicWriteJson(join(root, BUDGET_FILE), next);
  return next;
}

async function loadLedger(root) {
  return (await readJsonOrNull(join(root, LEDGER_FILE))) ?? { sends: [] };
}

async function saveLedger(root, ledger) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await atomicWriteJson(join(root, LEDGER_FILE), ledger);
}

function pruneWindow(timestamps, windowMs, now) {
  return (timestamps ?? []).filter((ts) => now - ts < windowMs);
}

/**
 * Throws OlimpyxBudgetExceededError when messages_per_hour is already at its limit.
 * Makes no network call and no filesystem write beyond reading the existing files
 * (AC-9: "over-budget sends fail locally ... and make no network call").
 */
export async function checkMessagesPerHour(root, { now = Date.now(), budget } = {}) {
  const effective = budget !== undefined ? budget : await loadBudget(root);
  if (!effective?.messages_per_hour) return;
  const ledger = await loadLedger(root);
  const sends = pruneWindow(ledger.sends, HOUR_MS, now);
  if (sends.length >= effective.messages_per_hour) {
    const resetAt = new Date(sends[0] + HOUR_MS).toISOString();
    throw new OlimpyxBudgetExceededError(
      `Local budget exceeded: messages_per_hour limit of ${effective.messages_per_hour} reached. Resets at ${resetAt}.`,
      { limit: effective.messages_per_hour, resetAt }
    );
  }
}

/** Records a successful send. A stable key counts a replay once per rolling hour.
 * Callers must serialize ledger mutations, as with existing unkeyed sends.
 */
export async function recordSend(root, { now = Date.now(), key } = {}) {
  if (key !== undefined && (typeof key !== 'string' || !key.trim())) {
    throw new Error('Send operation key must be a non-empty string');
  }
  const ledger = await loadLedger(root);
  const sends = pruneWindow(ledger.sends, HOUR_MS, now);
  const sendKeys = (ledger.send_keys ?? []).filter((entry) => now - entry.at < HOUR_MS);
  if (key === undefined || !sendKeys.some((entry) => entry.key === key)) {
    sends.push(now);
    if (key !== undefined) sendKeys.push({ key, at: now });
  }
  await saveLedger(root, { ...ledger, sends, send_keys: sendKeys });
}

/**
 * "Own task rooms" (PRD §3.4) = a room containing a non-terminal task assigned to this
 * agent, or created by this agent or its owner. Fails safe to false (not-own) on any
 * network error, so a transient failure makes the stricter policy apply rather than
 * silently bypassing it.
 *
 * A task created by an owner only counts as "own" when its creator.actor_id matches
 * *this* agent's own `ownerId` -- a room can be shared by agents belonging to different
 * owners, and a task created by some other owner is not this agent's own task just
 * because the creator happens to be an owner. When `ownerId` isn't known locally, an
 * owner-created task is treated as not-own (fail-safe) rather than assumed to match.
 */
export async function isOwnTaskRoom(client, roomId, { agentId, ownerId } = {}) {
  if (!roomId) return false;
  try {
    const res = await client.request('GET', `/v1/rooms/${encodeURIComponent(roomId)}/tasks`);
    const tasks = res?.data ?? [];
    return tasks.some((task) => {
      if (['completed', 'failed', 'cancelled'].includes(task?.status)) return false;
      if (agentId && task?.assigned_agent_id === agentId) return true;
      // GET /v1/rooms/:roomId/tasks nests the creator as `creator: { actor_type, actor_id }`
      // (apps/server/src/app.ts taskFrom); it has no flat creator_type/creator_id fields.
      const creatorType = task?.creator?.actor_type ?? task?.creator_type;
      const creatorId = task?.creator?.actor_id ?? task?.creator_id;
      if (agentId && creatorType === 'agent' && creatorId === agentId) return true;
      // Only this agent's own owner's tasks count -- a different owner's task in a
      // shared room is not "own" merely because the creator is an owner.
      if (ownerId && creatorType === 'owner' && creatorId === ownerId) return true;
      return false;
    });
  } catch {
    return false;
  }
}

/**
 * "Thread author" (PRD §3.4) = the root message's sender, via GET /v1/messages/:id.
 * A message that is itself a reply carries `root_message_id` pointing at the thread
 * root (the 2-level flat hierarchy means this is always the true root, never a further
 * chain); when present, the root's sender -- not the fetched message's own sender -- is
 * the thread author. Returns `{ id, type }` (`type` is `'agent'` or `'owner'`, mirroring
 * `sender_type`) so callers can tell an agent-authored thread from an owner-authored one.
 */
export async function resolveThreadAuthor(client, messageId) {
  if (!messageId) return null;
  try {
    const res = await client.request('GET', `/v1/messages/${encodeURIComponent(messageId)}`);
    let message = res?.data ?? res;
    const rootId = message?.root_message_id;
    if (rootId && rootId !== messageId) {
      const rootRes = await client.request('GET', `/v1/messages/${encodeURIComponent(rootId)}`);
      message = rootRes?.data ?? rootRes;
    }
    const id = message?.sender_id ?? message?.sender?.actor_id ?? message?.sender?.id ?? null;
    if (id == null) return null;
    const type = message?.sender_type ?? message?.sender?.actor_type ?? 'agent';
    return { id, type };
  } catch {
    return null;
  }
}

/**
 * Evaluates the `help` policy for a reply, direct message, or forum (help-seeking) post.
 * `on` never restricts. Any other mode always allows activity inside the owner's own
 * task rooms (D-022: the owner's task comes first). A reply is also always allowed when
 * its thread author is this agent itself (`targetActorType === 'agent'` and
 * `targetAgentId === agentId`) or this agent's own owner (`targetActorType === 'owner'`
 * and `targetAgentId === ownerId`): continuing a thread the agent or its owner started
 * is not help-seeking outreach subject to the contacts gate. Otherwise: replies and
 * direct messages are allowed only to a contact; `off` additionally refuses new public
 * help-seeking posts outright (posting to the wider network at all), while `contacts`
 * still allows posting one (only the ensuing correspondence is contact-gated).
 */
export function evaluateHelpPolicy(budget, {
  kind, targetAgentId, targetActorType, isOwnTaskRoom: ownRoom = false, agentId, ownerId
} = {}) {
  const mode = budget?.help ?? 'on';
  if (mode === 'on' || ownRoom) return { allowed: true };

  if (kind === 'reply' && targetAgentId != null) {
    if (targetActorType === 'agent' && agentId != null && targetAgentId === agentId) return { allowed: true };
    if (targetActorType === 'owner' && ownerId != null && targetAgentId === ownerId) return { allowed: true };
  }

  const contacts = Array.isArray(budget?.contacts) ? budget.contacts : [];
  const isContact = targetAgentId != null && contacts.includes(targetAgentId);

  if (kind === 'direct_message' || kind === 'reply') {
    if (isContact) return { allowed: true };
    return {
      allowed: false,
      reason: `Local budget (help: ${mode}) refuses ${kind === 'direct_message' ? 'direct messages' : 'thread replies'} to agents outside contacts.`
    };
  }
  if (kind === 'forum_post') {
    if (mode === 'off') {
      return { allowed: false, reason: 'Local budget (help: off) refuses new public help-seeking posts.' };
    }
    return { allowed: true };
  }
  return { allowed: true };
}

/**
 * Orchestrates the local budget checks before an outbound send. Order matters: the
 * messages_per_hour check runs first and never touches the network (AC-9); only the
 * help-policy check may resolve a room's tasks or a thread's author over the network.
 * A missing budget.json short-circuits immediately with no checks (AC-9: unchanged
 * behavior). Throws OlimpyxBudgetExceededError or OlimpyxHelpPolicyBlockedError; does
 * not itself send anything or record the send -- call recordSend() after the real send
 * succeeds.
 */
export async function enforceSendBudget(client, root, { agentId, ownerId, kind, roomId, recipientAgentId, replyToMessageId } = {}, { now = Date.now() } = {}) {
  const budget = await loadBudget(root);
  if (!budget) return { budget: null };
  await checkMessagesPerHour(root, { now, budget });

  if (kind === 'reply' || kind === 'direct_message' || kind === 'forum_post') {
    const ownRoom = roomId ? await isOwnTaskRoom(client, roomId, { agentId, ownerId }) : false;
    if (!ownRoom) {
      let targetAgentId = recipientAgentId ?? null;
      let targetActorType = recipientAgentId ? 'agent' : undefined;
      if (kind === 'reply' && !targetAgentId && replyToMessageId) {
        const author = await resolveThreadAuthor(client, replyToMessageId);
        targetAgentId = author?.id ?? null;
        targetActorType = author?.type;
      }
      const verdict = evaluateHelpPolicy(budget, { kind, targetAgentId, targetActorType, isOwnTaskRoom: ownRoom, agentId, ownerId });
      if (!verdict.allowed) throw new OlimpyxHelpPolicyBlockedError(verdict.reason);
    }
  }
  return { budget };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function pruneSessionHistory(history, now) {
  return (history ?? []).filter((entry) => now - entry.ended_at < DAY_MS);
}

/**
 * Tracks the currently-observed session in the ledger and keeps `last_seen_at` current --
 * called by every budget-checked command (`listen` and `wait`, via checkSessionBudget) so
 * elapsed time reflects the last moment activity was actually observed, not just the moment
 * a session began. When `sessionId` differs from the ledger's tracked session, the previous
 * one is archived into `session_history` first, using *its* last-seen time as the end point
 * (not `now`) -- so a session that crashed or was never cleanly ended (no `session end` /
 * `recordSessionEnd`) still contributes its real observed elapsed time instead of either the
 * full crash-to-restart gap or nothing at all. A session already archived by `recordSessionEnd`
 * (which clears the tracked fields) is never re-archived here.
 */
async function touchSession(root, sessionId, now) {
  const ledger = await loadLedger(root);
  if (ledger.session_id !== sessionId) {
    if (ledger.session_id && ledger.session_started_at) {
      const endedAt = ledger.last_seen_at ?? ledger.session_started_at;
      const history = pruneSessionHistory(ledger.session_history, now);
      history.push({ session_id: ledger.session_id, started_at: ledger.session_started_at, ended_at: endedAt });
      ledger.session_history = history;
    }
    ledger.session_id = sessionId;
    ledger.session_started_at = now;
  } else if (!ledger.session_started_at) {
    ledger.session_started_at = now;
  }
  ledger.last_seen_at = now;
  await saveLedger(root, ledger);
  return ledger.session_started_at;
}

/**
 * Tracks elapsed local-session time against `session_minutes`, keyed to `sessionId`
 * so a fresh `session begin` resets the clock. Returns `{ exhausted: false }`
 * immediately when there's no budget.json or no session_minutes set. Every call
 * (from `listen` or `wait`) advances the ledger's `last_seen_at` (see `touchSession`).
 */
export async function checkSessionBudget(root, sessionId, { now = Date.now() } = {}) {
  const budget = await loadBudget(root);
  if (!budget?.session_minutes || !sessionId) return { exhausted: false };
  const startedAt = await touchSession(root, sessionId, now);
  const elapsedMinutes = (now - startedAt) / 60_000;
  return { exhausted: elapsedMinutes >= budget.session_minutes, startedAt, elapsedMinutes, limitMinutes: budget.session_minutes };
}

/**
 * Archives a just-finished session's tracked elapsed time into the rolling 24h ledger
 * history (`session_history`), so `checkSessionBeginBudget` can see it after the ledger
 * moves on to a new `session_id`. Only archives when the ledger was actively tracking
 * `sessionId` (i.e. `checkSessionBudget`/`listen`/`wait` observed it at least once) -- a
 * session that never polled either has nothing local to archive. Call this from `session
 * end` and from any teardown that ends a session (e.g. `listen`'s SIGINT/SIGTERM handler).
 * Clears the ledger's tracked session afterward so a later `touchSession` switch never
 * re-archives the same span a second time. Best-effort: swallows errors so a failed
 * archive never blocks session teardown.
 */
export async function recordSessionEnd(root, sessionId, { now = Date.now() } = {}) {
  if (!sessionId) return;
  try {
    const ledger = await loadLedger(root);
    if (ledger.session_id !== sessionId || !ledger.session_started_at) return;
    const history = pruneSessionHistory(ledger.session_history, now);
    history.push({ session_id: sessionId, started_at: ledger.session_started_at, ended_at: now });
    await saveLedger(root, { ...ledger, session_id: null, session_started_at: null, last_seen_at: null, session_history: history });
  } catch {
    // best-effort
  }
}

/**
 * `session begin` (PRD §3.4: the CLI enforces the local budget "on listen and session"):
 * refuses locally, before any network call, when this agent's cumulative tracked
 * participation time across sessions in the trailing 24h -- archived by `recordSessionEnd`,
 * plus whatever the *currently* tracked session has accrued even though it was never cleanly
 * ended -- already meets or exceeds `session_minutes`. This is distinct from
 * `checkSessionBudget`, which bounds a single already-running session; this bounds how much
 * a *new* session is allowed to begin after previous sessions already used up the daily
 * allowance, including one still open from a crash or a missed `session end`. A no-op
 * (never exhausted) without a budget.json or without `session_minutes` set.
 */
export async function checkSessionBeginBudget(root, { now = Date.now() } = {}) {
  const budget = await loadBudget(root);
  if (!budget?.session_minutes) return { exhausted: false };
  const ledger = await loadLedger(root);
  const history = pruneSessionHistory(ledger.session_history, now);
  let elapsedMs = history.reduce((sum, entry) => sum + Math.max(0, entry.ended_at - entry.started_at), 0);
  if (ledger.session_id && ledger.session_started_at) {
    const trackedEnd = ledger.last_seen_at ?? ledger.session_started_at;
    elapsedMs += Math.max(0, trackedEnd - ledger.session_started_at);
  }
  const elapsedMinutes = elapsedMs / 60_000;
  return { exhausted: elapsedMinutes >= budget.session_minutes, elapsedMinutes, limitMinutes: budget.session_minutes };
}
