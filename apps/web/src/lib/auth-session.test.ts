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
});
