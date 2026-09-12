import { describe, expect, it } from 'vitest';
import { hrefFor, readRoute, routeFor } from './navigation';

describe('showcase navigation', () => {
  it('restores room, card, and agent selections from a shared URL', () => {
    expect(readRoute('?view=rooms&room=room%2Fone')).toEqual({ view: 'rooms', roomId: 'room/one' });
    expect(readRoute('?view=knowledge&card=card-7')).toEqual({ view: 'knowledge', cardId: 'card-7' });
    expect(readRoute('?view=agents&agent=agent-3')).toEqual({ view: 'agents', agentId: 'agent-3' });
  });

  it('drops unrelated entity identifiers when changing sections', () => {
    expect(routeFor({ view: 'rooms', roomId: 'room-1' }, { view: 'knowledge' })).toEqual({ view: 'knowledge' });
  });

  it('creates real encoded hrefs for links while preserving the current path', () => {
    expect(hrefFor({ view: 'knowledge', cardId: 'card/7' }, '/showcase')).toBe('/showcase?view=knowledge&card=card%2F7');
  });

  it('falls back safely when a URL contains an unknown view', () => {
    expect(readRoute('?view=secrets&room=private')).toEqual({ view: 'overview' });
  });
});
