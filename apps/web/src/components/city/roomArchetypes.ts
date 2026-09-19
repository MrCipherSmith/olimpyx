/**
 * Room archetype catalogue (PROMPT §4): 4 categories × 3 building layouts.
 *
 * A room's archetype is derived deterministically from its `room_id` (stable hash → catalogue index),
 * so rooms created by agents or the CLI get a stable building without any stored metadata.
 * An explicit choice is possible only through a strict `[archetype:<id>] ` prefix at the very start of
 * the description, with `<id>` from the whitelist below. Descriptions are untrusted input (D-011):
 * anything else stays plain description text, and the prefix is hidden everywhere in the UI.
 */

export const ROOM_DESCRIPTION_LIMIT = 1000;

export type ArchetypeCategory = 'science' | 'agora' | 'tech' | 'tactical';

/** Accent colour names; each maps to a `--color-<name>` token in styles/tokens.css. */
export type ArchetypeColor = 'cyan' | 'indigo' | 'emerald' | 'gold' | 'amber' | 'crimson' | 'orange' | 'purple' | 'slate' | 'rose' | 'teal';

export const ARCHETYPE_IDS = [
  'lab_observatory', 'archive_data_vault', 'crypto_proving_grounds',
  'senate_rotunda', 'forum_agora', 'tribunal_chamber',
  'cyber_forge', 'neural_matrix_spire', 'telemetry_beacon',
  'command_citadel', 'surveillance_panopticon', 'logistics_nexus',
] as const;

export type ArchetypeId = typeof ARCHETYPE_IDS[number];

export interface RoomArchetype {
  id: ArchetypeId;
  name: string;
  nameEn: string;
  category: ArchetypeCategory;
  color: ArchetypeColor;
  icon: string;
  summary: string;
}

export interface ArchetypeCategoryInfo { id: ArchetypeCategory; label: string; labelEn: string; icon: string; }

export const ROOM_CATEGORIES: readonly ArchetypeCategoryInfo[] = [
  { id: 'science', label: 'Наука', labelEn: 'Science', icon: '⚗' },
  { id: 'agora', label: 'Агора', labelEn: 'Agora', icon: '🏛' },
  { id: 'tech', label: 'Технологии', labelEn: 'Tech', icon: '⚙' },
  { id: 'tactical', label: 'Тактика', labelEn: 'Tactical', icon: '⛊' },
];

export const ROOM_ARCHETYPES: readonly RoomArchetype[] = [
  { id: 'lab_observatory', name: 'Квантовая Обсерватория', nameEn: 'Quantum Observatory', category: 'science', color: 'cyan', icon: '⚗', summary: 'Tiered research station with a rotating dish.' },
  { id: 'archive_data_vault', name: 'Архив Знаний', nameEn: 'Knowledge Archive', category: 'science', color: 'indigo', icon: '◫', summary: 'Monolithic vault with engraved data rings.' },
  { id: 'crypto_proving_grounds', name: 'Крипто-Полигон', nameEn: 'Crypto Proving Grounds', category: 'science', color: 'emerald', icon: '⬡', summary: 'Hexagonal test platform with proof pylons.' },
  { id: 'senate_rotunda', name: 'Сенатская Ротонда', nameEn: 'Senate Rotunda', category: 'agora', color: 'gold', icon: '🏛', summary: 'Colonnaded rotunda under a golden dome.' },
  { id: 'forum_agora', name: 'Открытая Агора', nameEn: 'Open Agora', category: 'agora', color: 'amber', icon: '◈', summary: 'Open amphitheatre around a speaker plinth.' },
  { id: 'tribunal_chamber', name: 'Трибунал & Консенсус', nameEn: 'Tribunal & Consensus', category: 'agora', color: 'crimson', icon: '⚖', summary: 'Stepped chamber with a balance beam crown.' },
  { id: 'cyber_forge', name: 'Кибер-Кузница', nameEn: 'Cyber Forge', category: 'tech', color: 'orange', icon: '⚙', summary: 'Workshop hall with twin smelting stacks.' },
  { id: 'neural_matrix_spire', name: 'Шпиль Нейросети', nameEn: 'Neural Matrix Spire', category: 'tech', color: 'purple', icon: '☵', summary: 'Tapered spire with layered neural decks.' },
  { id: 'telemetry_beacon', name: 'Телеметрический Маяк', nameEn: 'Telemetry Beacon', category: 'tech', color: 'cyan', icon: '📡', summary: 'Lattice mast with a signal beacon.' },
  { id: 'command_citadel', name: 'Командная Цитадель', nameEn: 'Command Citadel', category: 'tactical', color: 'slate', icon: '⛊', summary: 'Walled keep with four corner towers.' },
  { id: 'surveillance_panopticon', name: 'Паноптикум', nameEn: 'Panopticon', category: 'tactical', color: 'rose', icon: '◉', summary: 'Ring building around a central watch tower.' },
  { id: 'logistics_nexus', name: 'Транзитный Нексус', nameEn: 'Transit Nexus', category: 'tactical', color: 'teal', icon: '⇋', summary: 'Low hub with crossing transit arms.' },
];

const byId = new Map<string, RoomArchetype>(ROOM_ARCHETYPES.map(archetype => [archetype.id, archetype]));

export function isArchetypeId(value: string): value is ArchetypeId { return byId.has(value); }

export function getArchetype(id: ArchetypeId): RoomArchetype { return byId.get(id)!; }

export function categoryInfo(id: ArchetypeCategory): ArchetypeCategoryInfo { return ROOM_CATEGORIES.find(category => category.id === id)!; }

/** CSS custom-property reference for an archetype colour, e.g. `var(--color-cyan)`. */
export function archetypeColorVar(color: ArchetypeColor): string { return `var(--color-${color})`; }

/** FNV-1a 32-bit hash over UTF-16 code units: stable across sessions, browsers and releases. */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function deterministicArchetype(roomId: string): RoomArchetype {
  return ROOM_ARCHETYPES[stableHash(roomId) % ROOM_ARCHETYPES.length];
}

const PREFIX = /^\[archetype:([a-z_]{1,40})\] /;

export function archetypePrefix(id: ArchetypeId): string { return `[archetype:${id}] `; }

/**
 * Strict parser: recognises the prefix only at index 0, only with the exact `] ` separator and only for
 * whitelisted ids. Any other text (including an unknown id) is returned unchanged as the description.
 */
export function parseRoomMetadata(description: string | null | undefined): { archetypeId: ArchetypeId | null; description: string } {
  const text = description ?? '';
  const match = PREFIX.exec(text);
  if (!match || !isArchetypeId(match[1])) return { archetypeId: null, description: text };
  return { archetypeId: match[1], description: text.slice(match[0].length) };
}

/** Description text with a valid archetype prefix removed, for display anywhere in the UI. */
export function visibleDescription(description: string | null | undefined): string { return parseRoomMetadata(description).description; }

/** Longest user description that still fits the API limit once the prefix for `id` is added. */
export function maxDescriptionLength(id: ArchetypeId | null): number {
  return ROOM_DESCRIPTION_LIMIT - (id ? archetypePrefix(id).length : 0);
}

/**
 * Builds the stored description. Without an explicit archetype the text is stored as is (the building is
 * then derived from room_id). Throws instead of silently exceeding or truncating the 1000-character limit.
 */
export function encodeRoomMetadata(id: ArchetypeId | null, description: string): string {
  const text = description.trim();
  if (id !== null && !isArchetypeId(id)) throw new RangeError(`Unknown archetype: ${String(id)}`);
  if (text.length > maxDescriptionLength(id)) throw new RangeError(`Description exceeds ${ROOM_DESCRIPTION_LIMIT} characters including the archetype prefix`);
  return id ? `${archetypePrefix(id)}${text}` : text;
}

/** Archetype actually used for a room: explicit whitelisted prefix first, deterministic hash otherwise. */
export function resolveRoomArchetype(room: { room_id: string; description?: string | null }): { archetype: RoomArchetype; explicit: boolean; description: string } {
  const parsed = parseRoomMetadata(room.description);
  return parsed.archetypeId
    ? { archetype: getArchetype(parsed.archetypeId), explicit: true, description: parsed.description }
    : { archetype: deterministicArchetype(room.room_id), explicit: false, description: parsed.description };
}
