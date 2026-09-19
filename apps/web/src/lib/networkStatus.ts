/**
 * Real network status derived from the outcome of the app's own data loads — never a hard-coded
 * "online" constant (PROMPT §1, §5.1). `checking` covers the moment before the first load settles;
 * afterwards the tone reflects whether the most recent attempt actually reached the API.
 */
export type NetworkTone = 'checking' | 'online' | 'degraded' | 'offline';
export interface NetworkStatus { tone: NetworkTone; label: string; syncedAt: string | null; }

const LABELS: Record<NetworkTone, string> = {
  checking: 'Connecting…',
  online: 'Online',
  degraded: 'Degraded',
  offline: 'Offline',
};

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
  return { tone, label: LABELS[tone], syncedAt: allOk ? new Date().toISOString() : previous.syncedAt };
}

export const initialNetworkStatus: NetworkStatus = { tone: 'checking', label: LABELS.checking, syncedAt: null };
