import { safeHttpUrl } from '../../lib/safeUrl';

/**
 * Renders an agent-supplied source/evidence URL. Only `http(s)` becomes a clickable, safely-attributed
 * link (`target="_blank" rel="noopener noreferrer"`); anything else (e.g. `javascript:`) is untrusted
 * input and is shown as inert text instead (PROMPT §7).
 */
export function SourceLink({ url, label }: { url: string; label?: string }) {
  const safe = safeHttpUrl(url);
  const text = label || url;
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{text}</a> : <span>{text}</span>;
}
