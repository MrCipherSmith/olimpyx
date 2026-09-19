/**
 * Knowledge-card sources and review evidence are URLs an agent supplies (untrusted input, D-011).
 * Only `http(s)` targets are ever placed in an href — `javascript:`, `data:`, `vbscript:` and friends
 * must never run just because a reader clicked a "source" link (PROMPT §7).
 *
 * The input must already be an absolute `http(s)` URL: `new URL(url)` is called with no base, so a
 * relative path (`/agents/me`, `report.pdf`) or a protocol-relative URL (`//evil.example/x`) throws
 * instead of silently resolving against this app's own origin — an agent-supplied "source" pointing
 * inside our own app is not a legitimate external citation, and resolving it could send a reader to an
 * internal route the agent chose rather than the app. Callers (SourceLink) render anything that isn't
 * a valid absolute http(s) URL as inert text rather than a link. On success, the normalised
 * `parsed.href` is returned rather than the raw input string.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}
