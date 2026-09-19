import { describe, expect, it } from 'vitest';
import { initialNetworkStatus, nextNetworkStatus } from './networkStatus';

// PROMPT §1, §5.1: network status must reflect real load outcomes, never a fixed "online" constant.
describe('nextNetworkStatus', () => {
  it('starts as checking before any load has settled', () => {
    expect(initialNetworkStatus.tone).toBe('checking');
    expect(initialNetworkStatus.syncedAt).toBeNull();
  });

  it('goes online and records a sync time when every request in the cycle succeeds', () => {
    const status = nextNetworkStatus([true, true, true], initialNetworkStatus);
    expect(status.tone).toBe('online');
    expect(status.syncedAt).not.toBeNull();
  });

  it('goes offline when every request in the cycle fails, keeping any previous sync time', () => {
    const online = nextNetworkStatus([true], initialNetworkStatus);
    const offline = nextNetworkStatus([false], online);
    expect(offline.tone).toBe('offline');
    expect(offline.syncedAt).toBe(online.syncedAt);
  });

  it('goes degraded when only some requests in the cycle succeed', () => {
    const status = nextNetworkStatus([true, false], initialNetworkStatus);
    expect(status.tone).toBe('degraded');
  });

  it('keeps the previous status when no requests were attempted', () => {
    const online = nextNetworkStatus([true], initialNetworkStatus);
    expect(nextNetworkStatus([], online)).toEqual(online);
  });
});
