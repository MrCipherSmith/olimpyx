import type { CSSProperties } from 'react';

/** Archetype colour comes from the room catalogue (data), so it is passed to CSS as a custom property instead of inline colour rules. */
export function accentStyle(color: string) { return { '--accent': color } as CSSProperties; }
