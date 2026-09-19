import { describe, expect, it } from 'vitest';
import { initialNetworkStatus, nextNetworkStatus, nextPollNetworkStatus, type NetworkStatus } from './networkStatus';

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

// PROMPT §1, §5.1: a single lightweight probe (the room-message poll) must not carry the same
// authority as a full load cycle — only a real network failure may declare Offline, and success
// alone must never fast-forward straight to Online.
describe('nextPollNetworkStatus', () => {
  const online: NetworkStatus = { tone: 'online', label: 'Online', syncedAt: 't0' };
  const degraded: NetworkStatus = { tone: 'degraded', label: 'Degraded', syncedAt: 't0' };
  const offline: NetworkStatus = { tone: 'offline', label: 'Offline', syncedAt: 't0' };

  it('a network failure (no response at all) marks the network offline', () => {
    expect(nextPollNetworkStatus({ ok: false, status: 0 }, online).tone).toBe('offline');
    expect(nextPollNetworkStatus({ ok: false }, online).tone).toBe('offline');
  });

  it('a 5xx from a reachable API is degraded, not offline', () => {
    expect(nextPollNetworkStatus({ ok: false, status: 500 }, online).tone).toBe('degraded');
    expect(nextPollNetworkStatus({ ok: false, status: 503 }, online).tone).toBe('degraded');
  });

  it('a 4xx from a reachable API leaves the current status untouched', () => {
    expect(nextPollNetworkStatus({ ok: false, status: 403 }, online)).toEqual(online);
    expect(nextPollNetworkStatus({ ok: false, status: 404 }, degraded)).toEqual(degraded);
    expect(nextPollNetworkStatus({ ok: false, status: 404 }, offline)).toEqual(offline);
  });

  it('a successful poll does not upgrade a degraded status to online — only a full load can', () => {
    expect(nextPollNetworkStatus({ ok: true }, degraded)).toEqual(degraded);
  });

  it('a successful poll confirms reachability from offline, but only up to degraded, never online', () => {
    expect(nextPollNetworkStatus({ ok: true }, offline).tone).toBe('degraded');
  });

  it('a successful poll leaves an already-online status untouched', () => {
    expect(nextPollNetworkStatus({ ok: true }, online)).toEqual(online);
  });
});
