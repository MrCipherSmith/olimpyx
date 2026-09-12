export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
}

export interface StoredSession {
  token: string;
  user: AuthUser;
}

const storageKey = 'olimpyx.session';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export class AuthSession {
  get current(): StoredSession | null {
    const serialized = sessionStorage.getItem(storageKey);
    if (!serialized) return null;
    try {
      const session = JSON.parse(serialized) as StoredSession;
      return session.token && session.user?.id ? session : null;
    } catch {
      sessionStorage.removeItem(storageKey);
      return null;
    }
  }

  save(session: StoredSession): void {
    sessionStorage.setItem(storageKey, JSON.stringify(session));
  }

  clear(): void {
    sessionStorage.removeItem(storageKey);
  }

  authorizationHeaders(): Record<string, string> {
    return this.current ? { Authorization: `Bearer ${this.current.token}` } : {};
  }

  async withSession<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.clear();
      throw error;
    }
  }
}
