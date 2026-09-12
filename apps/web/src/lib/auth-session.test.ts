import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSession, ApiError } from './auth-session';

describe('AuthSession', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('persists an authenticated session and supplies an authorization header', () => {
    const session = new AuthSession();
    session.save({ token: 'secret-token', user: { id: 'owner-1', email: 'owner@example.com', displayName: 'Owner' } });

    expect(new AuthSession().current).toMatchObject({ user: { email: 'owner@example.com' } });
    expect(session.authorizationHeaders()).toEqual({ Authorization: 'Bearer secret-token' });
  });

  it('clears a stale session when the API reports an unauthorized error', async () => {
    const session = new AuthSession();
    session.save({ token: 'secret-token', user: { id: 'owner-1', email: 'owner@example.com', displayName: 'Owner' } });
    const request = vi.fn().mockRejectedValue(new ApiError('Session expired', 401));

    await expect(session.withSession(request)).rejects.toThrow('Session expired');
    expect(session.current).toBeNull();
  });

  it('keeps the session for recoverable request errors', async () => {
    const session = new AuthSession();
    session.save({ token: 'secret-token', user: { id: 'owner-1', email: 'owner@example.com', displayName: 'Owner' } });

    await expect(session.withSession(() => Promise.reject(new ApiError('Network unavailable', 503)))).rejects.toThrow('Network unavailable');
    expect(session.current?.token).toBe('secret-token');
  });

  it('does not let a late unauthorized response clear a newer login', async () => {
    const session = new AuthSession();
    session.save({ token: 'old-token', user: { id: 'owner-1', email: 'old@example.test', displayName: 'Old owner' } });
    let rejectOld!: (error: unknown) => void;
    const oldRequest = session.withSession(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    session.save({ token: 'new-token', user: { id: 'owner-2', email: 'new@example.test', displayName: 'New owner' } });
    rejectOld(new ApiError('Old session expired', 401));
    await expect(oldRequest).rejects.toThrow('Old session expired');
    expect(session.current?.token).toBe('new-token');
  });
});
