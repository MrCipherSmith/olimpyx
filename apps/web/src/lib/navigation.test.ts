import { describe, expect, it } from 'vitest';
import { hrefFor, readRoute, routeFor, screenFor } from './navigation';

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

  it('treats ?view=city (the old City Map tab) as the city itself, with no screen open', () => {
    expect(readRoute('?view=city')).toEqual({ view: 'overview' });
    expect(screenFor(readRoute('?view=city'))).toBeNull();
    expect(hrefFor({ view: 'overview' }, '/')).toBe('/');
  });
});

describe('city shell screens', () => {
  it('maps each route to the full-screen layer it opens over the city', () => {
    expect(screenFor({ view: 'overview' })).toBeNull();
    expect(screenFor({ view: 'rooms' })).toEqual({ kind: 'rooms', key: 'rooms' });
    expect(screenFor({ view: 'rooms', roomId: 'r1' })).toEqual({ kind: 'room', key: 'room:r1' });
    expect(screenFor({ view: 'knowledge', cardId: 'c1' })).toEqual({ kind: 'knowledge', key: 'knowledge' });
    expect(screenFor({ view: 'agents' })).toEqual({ kind: 'agents', key: 'agents:' });
    expect(screenFor({ view: 'agents', agentId: 'a1' })).toEqual({ kind: 'agents', key: 'agents:a1' });
    expect(screenFor({ view: 'owner' })).toEqual({ kind: 'owner', key: 'owner' });
  });

  it('keeps one screen key while a knowledge card changes, so focus is not pulled back to the heading', () => {
    expect(screenFor({ view: 'knowledge' })?.key).toBe(screenFor({ view: 'knowledge', cardId: 'c2' })?.key);
  });
});
