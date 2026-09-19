import { describe, expect, it } from 'vitest';
import {
  ARCHETYPE_IDS, ROOM_ARCHETYPES, ROOM_CATEGORIES, ROOM_DESCRIPTION_LIMIT, archetypeColorVar, archetypePrefix,
  deterministicArchetype, encodeRoomMetadata, maxDescriptionLength, parseRoomMetadata, resolveRoomArchetype,
  stableHash, visibleDescription,
} from './roomArchetypes';

describe('archetype catalogue', () => {
  it('has exactly 4 categories × 3 layouts from the §4 table', () => {
    expect(ROOM_CATEGORIES.map(category => category.id)).toEqual(['science', 'agora', 'tech', 'tactical']);
    expect(ROOM_ARCHETYPES).toHaveLength(12);
    for (const category of ROOM_CATEGORIES) expect(ROOM_ARCHETYPES.filter(item => item.category === category.id)).toHaveLength(3);
    expect(ROOM_ARCHETYPES.map(item => item.id)).toEqual([...ARCHETYPE_IDS]);
    expect(ROOM_ARCHETYPES.map(item => [item.id, item.color])).toEqual([
      ['lab_observatory', 'cyan'], ['archive_data_vault', 'indigo'], ['crypto_proving_grounds', 'emerald'],
      ['senate_rotunda', 'gold'], ['forum_agora', 'amber'], ['tribunal_chamber', 'crimson'],
      ['cyber_forge', 'orange'], ['neural_matrix_spire', 'purple'], ['telemetry_beacon', 'cyan'],
      ['command_citadel', 'slate'], ['surveillance_panopticon', 'rose'], ['logistics_nexus', 'teal'],
    ]);
  });

  it('refers to colours through design tokens only', () => {
    expect(archetypeColorVar('teal')).toBe('var(--color-teal)');
    for (const item of ROOM_ARCHETYPES) expect(item.color).not.toMatch(/^#/);
  });
});

describe('deterministic archetype from room_id', () => {
  it('is stable for the same id and independent of call order', () => {
    const ids = ['rom_01', 'rom_02', 'room-1', 'Ключ', ''];
    const first = ids.map(id => deterministicArchetype(id).id);
    const second = [...ids].reverse().map(id => deterministicArchetype(id).id).reverse();
    expect(second).toEqual(first);
    expect(stableHash('abc')).toBe(stableHash('abc'));
    expect(stableHash('abc')).toBe(0x1a47e90b); // FNV-1a reference value
  });

  it('spreads ids across the whole catalogue', () => {
    const seen = new Set(Array.from({ length: 400 }, (_, index) => deterministicArchetype(`rom_${index}`).id));
    expect(seen.size).toBe(12);
  });
});

describe('parseRoomMetadata', () => {
  it('recognises a whitelisted prefix at the very start and strips exactly the prefix', () => {
    expect(parseRoomMetadata('[archetype:forum_agora] Open debate')).toEqual({ archetypeId: 'forum_agora', description: 'Open debate' });
    expect(parseRoomMetadata('[archetype:cyber_forge] ')).toEqual({ archetypeId: 'cyber_forge', description: '' });
  });

  it('rejects unknown ids and keeps the text as description', () => {
    const text = '[archetype:evil_tower] hi';
    expect(parseRoomMetadata(text)).toEqual({ archetypeId: null, description: text });
    expect(parseRoomMetadata('[archetype:curia_senate] old WIP id')).toEqual({ archetypeId: null, description: '[archetype:curia_senate] old WIP id' });
  });

  it('ignores the prefix when it is not at the start or not in the strict form', () => {
    for (const text of [' [archetype:forum_agora] x', 'Note [archetype:forum_agora] x', '[archetype:forum_agora]x', '[Archetype:forum_agora] x', '[archetype:FORUM_AGORA] x', '[archetype: forum_agora] x', '<b>[archetype:forum_agora] x</b>']) {
      expect(parseRoomMetadata(text)).toEqual({ archetypeId: null, description: text });
    }
  });

  it('parses only one prefix; a second one stays visible text', () => {
    expect(parseRoomMetadata('[archetype:forum_agora] [archetype:cyber_forge] x')).toEqual({ archetypeId: 'forum_agora', description: '[archetype:cyber_forge] x' });
  });

  it('handles empty and missing descriptions', () => {
    expect(parseRoomMetadata('')).toEqual({ archetypeId: null, description: '' });
    expect(parseRoomMetadata(undefined)).toEqual({ archetypeId: null, description: '' });
    expect(parseRoomMetadata(null)).toEqual({ archetypeId: null, description: '' });
    expect(visibleDescription('[archetype:logistics_nexus] Routes')).toBe('Routes');
  });
});

describe('encodeRoomMetadata', () => {
  it('stores plain text when no archetype is chosen', () => {
    expect(encodeRoomMetadata(null, '  Plain  ')).toBe('Plain');
    expect(encodeRoomMetadata(null, '')).toBe('');
  });

  it('round-trips every whitelisted archetype', () => {
    for (const id of ARCHETYPE_IDS) {
      const stored = encodeRoomMetadata(id, 'Topic text');
      expect(stored.startsWith(archetypePrefix(id))).toBe(true);
      expect(parseRoomMetadata(stored)).toEqual({ archetypeId: id, description: 'Topic text' });
    }
    expect(parseRoomMetadata(encodeRoomMetadata('senate_rotunda', ''))).toEqual({ archetypeId: 'senate_rotunda', description: '' });
  });

  it('never exceeds the 1000-character description limit including the prefix', () => {
    const id = 'surveillance_panopticon';
    const max = maxDescriptionLength(id);
    expect(max).toBe(ROOM_DESCRIPTION_LIMIT - archetypePrefix(id).length);
    expect(encodeRoomMetadata(id, 'x'.repeat(max))).toHaveLength(ROOM_DESCRIPTION_LIMIT);
    expect(() => encodeRoomMetadata(id, 'x'.repeat(max + 1))).toThrow(RangeError);
    expect(encodeRoomMetadata(null, 'x'.repeat(1000))).toHaveLength(1000);
    expect(() => encodeRoomMetadata(null, 'x'.repeat(1001))).toThrow(RangeError);
  });

  it('refuses ids outside the whitelist', () => {
    expect(() => encodeRoomMetadata('evil_tower' as never, 'x')).toThrow(RangeError);
  });
});

describe('resolveRoomArchetype', () => {
  it('prefers an explicit prefix and hides it; falls back to the room_id hash', () => {
    expect(resolveRoomArchetype({ room_id: 'rom_1', description: '[archetype:tribunal_chamber] Votes' })).toMatchObject({ explicit: true, description: 'Votes', archetype: { id: 'tribunal_chamber' } });
    const derived = resolveRoomArchetype({ room_id: 'rom_1', description: '[archetype:unknown] Votes' });
    expect(derived).toMatchObject({ explicit: false, description: '[archetype:unknown] Votes' });
    expect(derived.archetype.id).toBe(deterministicArchetype('rom_1').id);
  });
});
