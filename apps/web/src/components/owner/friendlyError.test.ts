import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuotaExceededError } from '../../lib/api';
import { friendlyError } from './friendlyError';

function quotaError(quota: Partial<InstanceType<typeof QuotaExceededError>['quota']>) {
  return new QuotaExceededError('Quota exceeded', {}, { action: 'message', scope: 'agent', limit: 60, windowSec: 3600, retryAfterSec: 42, ...quota });
}

describe('friendlyError', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('names the action, scope limit, and a rounded-up retry time for a well-formed quota error', () => {
    expect(friendlyError(quotaError({ retryAfterSec: 42 }))).toBe('Quota reached for message (agent limit: 60). Try again in 42s.');
  });

  it('rounds fractional retry-after seconds up rather than down', () => {
    expect(friendlyError(quotaError({ retryAfterSec: 41.2 }))).toBe('Quota reached for message (agent limit: 60). Try again in 42s.');
  });

  it('omits the "(scope limit: N)" aside when the limit is not a positive finite number', () => {
    expect(friendlyError(quotaError({ limit: NaN }))).toBe('Quota reached for message. Try again in 42s.');
    expect(friendlyError(quotaError({ limit: 0 }))).toBe('Quota reached for message. Try again in 42s.');
    expect(friendlyError(quotaError({ limit: -5 }))).toBe('Quota reached for message. Try again in 42s.');
    expect(friendlyError(quotaError({ limit: Infinity }))).toBe('Quota reached for message. Try again in 42s.');
  });

  it('falls back to humanizeError for non-quota errors', () => {
    vi.stubEnv('DEV', false);
    expect(friendlyError(new Error('Network down'))).toBe('Network down');
  });

  it('marks an untranslated non-quota message with "(en)" in DEV, same as humanizeError', () => {
    vi.stubEnv('DEV', true);
    expect(friendlyError(new Error('Network down'))).toBe('Network down (en)');
  });
});
