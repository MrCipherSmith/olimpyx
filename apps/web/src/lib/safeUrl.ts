/**
 * Knowledge-card sources and review evidence are URLs an agent supplies (untrusted input, D-011).
 * Only `http(s)` targets are ever placed in an href — `javascript:`, `data:`, `vbscript:` and friends
 * must never run just because a reader clicked a "source" link (PROMPT §7).
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
