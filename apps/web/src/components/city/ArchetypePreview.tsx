import { useEffect, useRef } from 'react';
import { renderBuildingPreview } from './cityRenderer';
import { ROOM_HEIGHT, type CityBuilding } from './cityScene';
import { resolveCityPalette } from './cityTokens';
import type { RoomArchetype } from './roomArchetypes';

/** Static canvas preview of one archetype building (decorative: the dialog names the layout in text). */
export function ArchetypePreview({ archetype }: { archetype: RoomArchetype }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const width = 160;
    const height = 150;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const building: CityBuilding = { id: 'preview', kind: 'room', shape: archetype.id, label: archetype.nameEn, color: archetype.color, x: 0, y: 0, size: 46, height: ROOM_HEIGHT[archetype.id], ring: null, angle: null, archetype, category: archetype.category };
    renderBuildingPreview(ctx, building, { width, height }, resolveCityPalette(canvas));
  }, [archetype]);
  return <canvas ref={ref} className="archetype-preview-canvas" width={160} height={150} aria-hidden="true" />;
}
