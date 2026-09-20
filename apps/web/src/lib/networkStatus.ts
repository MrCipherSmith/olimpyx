/**
 * Real network status derived from the outcome of the app's own data loads — never a hard-coded
 * "online" constant (PROMPT §1, §5.1). `checking` covers the moment before the first load settles;
 * afterwards the tone reflects whether the most recent attempt actually reached the API.
 *
 * The human-readable label is rendered by NetworkStatusBadge from `tone` via the i18n catalog, so this
 * module no longer carries an English-only string alongside the state.
 */
export type NetworkTone = 'checking' | 'online' | 'degraded' | 'offline';
export interface NetworkStatus { tone: NetworkTone; syncedAt: string | null; }

/**
 * @param outcomes One boolean per request attempted in the latest load cycle (true = succeeded).
 * @param previous The status before this load cycle, used to keep the last successful sync time
 *   and to tell "never connected" apart from "was online, lost the connection".
 */
export function nextNetworkStatus(outcomes: boolean[], previous: NetworkStatus): NetworkStatus {
  if (!outcomes.length) return previous;
  const allOk = outcomes.every(Boolean);
  const anyOk = outcomes.some(Boolean);
  const tone: NetworkTone = allOk ? 'online' : anyOk ? 'degraded' : 'offline';
  return { tone, syncedAt: allOk ? new Date().toISOString() : previous.syncedAt };
}

export const initialNetworkStatus: NetworkStatus = { tone: 'checking', syncedAt: null };

/**
 * Outcome of a single lightweight probe (e.g. the 5s room-message poll), as opposed to the full load's
 * one-boolean-per-endpoint outcomes above. `status` is the HTTP status of a response that did arrive —
 * 0 (or omitted) means the request never reached the API at all (fetch threw / ApiError status 0).
 */
export type PollResult = { ok: true } | { ok: false; status?: number };

/**
 * Derives network status from a single probe without the full load's authority: a probe only ever
 * touches one endpoint, so it must not claim the sweeping "every endpoint is fine" of Online, nor
 * "nothing works" of Offline, on weaker evidence than a full load cycle provides (PROMPT §5.1).
 *
 * - No response at all (network failure, `status` 0/absent) is the only thing that marks Offline.
 * - A 5xx proves the API is reachable but currently erroring — Degraded is an accurate, not alarmist,
 *   read of that.
 * - A 4xx is the reachable API correctly rejecting this one request (e.g. 403/404); it says nothing
 *   about overall connectivity, so the current status is left untouched.
 * - A success confirms reachability but is not the full load — it may not upgrade Degraded (or Offline)
 *   all the way to Online; only the next full successful load can restore Online.
 */
export function nextPollNetworkStatus(result: PollResult, previous: NetworkStatus): NetworkStatus {
  if (result.ok) {
    if (previous.tone === 'offline') return { ...previous, tone: 'degraded' };
    return previous;
  }
  const status = result.status ?? 0;
  if (status === 0) return { ...previous, tone: 'offline' };
  if (status >= 500) return { ...previous, tone: 'degraded' };
  return previous;
}
