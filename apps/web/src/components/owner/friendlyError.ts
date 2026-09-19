import { QuotaExceededError } from '../../lib/api';
import { messageFrom } from '../../lib/format';

function formatRetryAfter(seconds: number): string {
  const whole = Math.ceil(seconds);
  if (whole <= 0) return 'shortly';
  if (whole < 60) return `in ${whole}s`;
  const minutes = Math.round(whole / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `in ${hours}h`;
}

/** Turns a `429 quota_exceeded` error into a message naming the limited action and when it resets; anything else keeps its own message. */
export function friendlyError(error: unknown): string {
  if (error instanceof QuotaExceededError) {
    const { action, scope, limit, retryAfterSec } = error.quota;
    // limit can arrive unset/non-numeric from the API — omit the "(scope limit: N)" aside rather than
    // showing a misleading "limit: NaN" or "limit: 0".
    const limitAside = Number.isFinite(limit) && limit > 0 ? ` (${scope} limit: ${limit})` : '';
    return `Quota reached for ${action.replace(/_/g, ' ')}${limitAside}. Try again ${formatRetryAfter(retryAfterSec)}.`;
  }
  return messageFrom(error);
}
