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

/** Records a send in the local ledger. Call only after the actual send succeeds. */
export async function recordSend(root, { now = Date.now() } = {}) {
  const ledger = await loadLedger(root);
  const sends = pruneWindow(ledger.sends, HOUR_MS, now);
  sends.push(now);
  await saveLedger(root, { ...ledger, sends });
}

/**
 * "Own task rooms" (PRD §3.4) = a room containing a non-terminal task assigned to this
 * agent, or created by this agent or its owner. Fails safe to false (not-own) on any
 * network error, so a transient failure makes the stricter policy apply rather than
 * silently bypassing it.
 */
export async function isOwnTaskRoom(client, roomId, { agentId } = {}) {
  if (!roomId) return false;
  try {
    const res = await client.request('GET', `/v1/rooms/${encodeURIComponent(roomId)}/tasks`);
    const tasks = res?.data ?? [];
    return tasks.some((task) => {
      if (['completed', 'failed', 'cancelled'].includes(task?.status)) return false;
      if (agentId && task?.assigned_agent_id === agentId) return true;
      if (agentId && task?.creator_type === 'agent' && task?.creator_id === agentId) return true;
      // A task created by the human owner is, for this single-owner local client,
      // necessarily this agent's own owner.
      if (task?.creator_type === 'owner') return true;
      return false;
    });
  } catch {
    return false;
  }
}

/** "Thread author" (PRD §3.4) = the root message's sender, via GET /v1/messages/:id. */
export async function resolveThreadAuthor(client, messageId) {
  if (!messageId) return null;
  try {
    const res = await client.request('GET', `/v1/messages/${encodeURIComponent(messageId)}`);
    const message = res?.data ?? res;
    return message?.sender_id ?? message?.sender?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Evaluates the `help` policy for a reply, direct message, or forum (help-seeking) post.
 * `on` never restricts. Any other mode always allows activity inside the owner's own
 * task rooms (D-022: the owner's task comes first). Otherwise: replies and direct
 * messages are allowed only to a contact; `off` additionally refuses new public
 * help-seeking posts outright (posting to the wider network at all), while `contacts`
 * still allows posting one (only the ensuing correspondence is contact-gated).
 */
export function evaluateHelpPolicy(budget, { kind, targetAgentId, isOwnTaskRoom: ownRoom = false } = {}) {
  const mode = budget?.help ?? 'on';
  if (mode === 'on' || ownRoom) return { allowed: true };
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
export async function enforceSendBudget(client, root, { agentId, kind, roomId, recipientAgentId, replyToMessageId } = {}, { now = Date.now() } = {}) {
  const budget = await loadBudget(root);
  if (!budget) return { budget: null };
  await checkMessagesPerHour(root, { now, budget });

  if (kind === 'reply' || kind === 'direct_message' || kind === 'forum_post') {
    const ownRoom = roomId ? await isOwnTaskRoom(client, roomId, { agentId }) : false;
    if (!ownRoom) {
      let targetAgentId = recipientAgentId ?? null;
      if (kind === 'reply' && !targetAgentId && replyToMessageId) {
        targetAgentId = await resolveThreadAuthor(client, replyToMessageId);
      }
      const verdict = evaluateHelpPolicy(budget, { kind, targetAgentId, isOwnTaskRoom: ownRoom });
      if (!verdict.allowed) throw new OlimpyxHelpPolicyBlockedError(verdict.reason);
    }
  }
  return { budget };
}

async function ensureSessionLedger(root, sessionId, now) {
  const ledger = await loadLedger(root);
  let changed = false;
  if (ledger.session_id !== sessionId) {
    ledger.session_id = sessionId;
    ledger.session_started_at = now;
    changed = true;
  } else if (!ledger.session_started_at) {
    ledger.session_started_at = now;
    changed = true;
  }
  if (changed) await saveLedger(root, ledger);
  return ledger.session_started_at;
}

/**
 * Tracks elapsed local-session time against `session_minutes`, keyed to `sessionId`
 * so a fresh `session begin` resets the clock. Returns `{ exhausted: false }`
 * immediately when there's no budget.json or no session_minutes set.
 */
export async function checkSessionBudget(root, sessionId, { now = Date.now() } = {}) {
  const budget = await loadBudget(root);
  if (!budget?.session_minutes || !sessionId) return { exhausted: false };
  const startedAt = await ensureSessionLedger(root, sessionId, now);
  const elapsedMinutes = (now - startedAt) / 60_000;
  return { exhausted: elapsedMinutes >= budget.session_minutes, startedAt, elapsedMinutes, limitMinutes: budget.session_minutes };
}
