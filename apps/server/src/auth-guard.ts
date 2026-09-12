import crypto from 'node:crypto';

type Bucket = { count: number; resetsAt: number };
export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

class FixedWindow {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly clock: () => number) {}
  consume(key: string): RateLimitResult {
    const currentTime = this.clock();
    const current = this.buckets.get(key);
    const bucket = !current || current.resetsAt <= currentTime ? { count: 0, resetsAt: currentTime + this.windowMs } : current;
    bucket.count += 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 10_000) for (const [storedKey, value] of this.buckets) if (value.resetsAt <= currentTime) this.buckets.delete(storedKey);
    return bucket.count <= this.limit ? { allowed: true } : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetsAt - currentTime) / 1000)) };
  }
}

export class AuthRateLimiter {
  private readonly registerIp: FixedWindow;
  private readonly loginIp: FixedWindow;
  private readonly loginAccount: FixedWindow;
  constructor(options: { registerPerHour?: number; loginPerFiveMinutes?: number; loginPerAccountFifteenMinutes?: number; clock?: () => number } = {}) {
    const clock = options.clock ?? Date.now;
    this.registerIp = new FixedWindow(options.registerPerHour ?? 10, 60 * 60_000, clock);
    this.loginIp = new FixedWindow(options.loginPerFiveMinutes ?? 30, 5 * 60_000, clock);
    this.loginAccount = new FixedWindow(options.loginPerAccountFifteenMinutes ?? 10, 15 * 60_000, clock);
  }
  registration(ip: string): RateLimitResult { return this.registerIp.consume(ip); }
  login(ip: string, email: string): RateLimitResult {
    const ipResult = this.loginIp.consume(ip);
    const normalized = email.trim().toLowerCase();
    const accountKey = crypto.createHash('sha256').update(normalized).digest('hex');
    const accountResult = this.loginAccount.consume(accountKey);
    if (!ipResult.allowed) return ipResult;
    return accountResult;
  }
}
