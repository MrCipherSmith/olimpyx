import { describe, it, expect } from 'vitest';
import {
  ROOM_ARCHETYPES,
  ROOM_CATEGORIES,
  getArchetype,
  parseRoomMetadata,
  encodeRoomMetadata
} from './roomArchetypes';

describe('roomArchetypes catalog and metadata helpers', () => {
  it('contains at least 10 unique archetypes across thematic categories', () => {
    expect(ROOM_ARCHETYPES.length).toBeGreaterThanOrEqual(10);
    const ids = new Set(ROOM_ARCHETYPES.map(a => a.id));
    expect(ids.size).toBe(ROOM_ARCHETYPES.length);
  });

  it('covers all thematic categories with metadata and icons', () => {
    expect(ROOM_CATEGORIES.length).toBeGreaterThanOrEqual(10);
    ROOM_CATEGORIES.forEach(cat => {
      const matching = ROOM_ARCHETYPES.filter(a => a.category === cat.id);
      expect(matching.length).toBeGreaterThan(0);
      expect(cat.label).toBeTruthy();
      expect(cat.icon).toBeTruthy();
    });
  });

  it('correctly parses and encodes room metadata', () => {
    const encoded = encodeRoomMetadata('curia_senate', 'Сенат консенсуса и кворум');
    expect(encoded).toBe('[archetype:curia_senate] Сенат консенсуса и кворум');

    const parsed = parseRoomMetadata(encoded);
    expect(parsed.archetype.id).toBe('curia_senate');
    expect(parsed.archetype.name).toBe('Курия / Сенат Кворума');
    expect(parsed.cleanDescription).toBe('Сенат консенсуса и кворум');
  });

  it('falls back gracefully on empty or non-tagged description', () => {
    const emptyParsed = parseRoomMetadata(undefined);
    expect(emptyParsed.archetype.id).toBe('lab_observatory');
    expect(emptyParsed.cleanDescription).toBe('');

    const plainParsed = parseRoomMetadata('Простая комната без тега');
    expect(plainParsed.archetype.id).toBe('lab_observatory');
    expect(plainParsed.cleanDescription).toBe('Простая комната без тега');
  });

  it('retrieves archetype by id with fallback', () => {
    const bourse = getArchetype('trading_bourse');
    expect(bourse.id).toBe('trading_bourse');
    expect(bourse.nameEn).toBe('Algorithmic Bourse');

    const fallback = getArchetype('non_existent_archetype');
    expect(fallback.id).toBe('lab_observatory');
  });
});
