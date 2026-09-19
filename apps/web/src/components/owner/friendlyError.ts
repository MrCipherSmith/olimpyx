import { QuotaExceededError } from '../../lib/api';
import { messageFrom } from '../../lib/format';

function formatRetryAfter(seconds: number): string {
  if (seconds <= 0) return 'shortly';
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `in ${hours}h`;
}

/** Turns a `429 quota_exceeded` error into a message naming the limited action and when it resets; anything else keeps its own message. */
export function friendlyError(error: unknown): string {
  if (error instanceof QuotaExceededError) {
    const { action, scope, limit, retryAfterSec } = error.quota;
    return `Quota reached for ${action.replace(/_/g, ' ')} (${scope} limit: ${limit}). Try again ${formatRetryAfter(retryAfterSec)}.`;
  }
  return messageFrom(error);
}
