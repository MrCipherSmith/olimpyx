import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';

// Opening a room shows the newest message. The list stays pinned to the bottom through new messages, refetches and
// reflows until the reader scrolls it themselves; only reader-initiated scrolling decides whether it is pinned.
export function MessageList({ roomId, messages, sentCount = 0, children }: { roomId: string; messages: { message_id: string }[]; sentCount?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useRef({ roomId: '', first: '', last: '', height: 0, pinned: true, intentAt: 0, anchor: null as string | null, sentCount });
  const stick = (element: HTMLDivElement) => { if (seen.current.pinned) element.scrollTop = element.scrollHeight; seen.current.height = element.scrollHeight; };
  const intent = () => { seen.current.intentAt = performance.now(); };
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return;
    const previous = seen.current, first = messages[0]?.message_id ?? '', last = messages.at(-1)?.message_id ?? '';
    // A #message-… link in the URL targets that message once it has rendered, instead of the latest one.
    if (previous.roomId !== roomId) { previous.pinned = true; previous.anchor = window.location.hash.startsWith('#message-') ? decodeURIComponent(window.location.hash.slice(1)) : null; }
    const target = previous.anchor ? document.getElementById(previous.anchor) : null;
    if (target && element.contains(target)) { target.scrollIntoView({ block: 'center' }); previous.pinned = false; previous.anchor = null; }
    else if (previous.roomId !== roomId || previous.sentCount !== sentCount) previous.pinned = true;
    else if (!previous.pinned && previous.first !== first && previous.last === last) element.scrollTop += element.scrollHeight - previous.height;
    seen.current = { ...previous, roomId, first, last, sentCount };
    stick(element);
  }, [roomId, messages, sentCount]);
  // Layout can settle after the first commit (grid sizing, fonts, a refetch swapping in a spinner); keep the bottom in view while pinned.
  useEffect(() => {
    const element = ref.current; if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => stick(element));
    observer.observe(element); for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [messages]);
  // Following an in-page message link is the reader moving away from the latest message.
  useEffect(() => { const unpin = () => { seen.current.pinned = false; intent(); }; window.addEventListener('hashchange', unpin); return () => window.removeEventListener('hashchange', unpin); }, []);
  const onScroll = (element: HTMLDivElement) => {
    if (performance.now() - seen.current.intentAt > 600) { stick(element); return; }
    seen.current.pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 80; seen.current.height = element.scrollHeight;
  };
  return <div className="message-list" ref={ref} onScroll={event => onScroll(event.currentTarget)} onWheel={intent} onTouchMove={intent} onKeyDown={intent} onPointerDown={intent} onPointerMove={event => { if (event.buttons) intent(); }}>{children}</div>;
}
