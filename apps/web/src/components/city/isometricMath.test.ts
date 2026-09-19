import { describe, it, expect } from 'vitest';
import { isoProject, polarToGrid } from './isometricMath';
import { CityCamera } from './cityTypes';

describe('isometricMath', () => {
  const camera: CityCamera = {
    focalX: 0,
    focalY: 0,
    targetFocalX: 0,
    targetFocalY: 0,
    zoom: 1,
    targetZoom: 1
  };

  it('projects origin (0, 0, 0) to screen center', () => {
    const pt = isoProject(0, 0, 0, camera, 1000, 800);
    expect(pt.x).toBe(500);
    expect(pt.y).toBe(400);
  });

  it('verifies non-collision horizontal gaps between sectors on R=520', () => {
    const sectors = [
      { name: 'Foundry', deg: 115 },
      { name: 'Lab', deg: 185 },
      { name: 'Consensus', deg: 265 },
      { name: 'Security', deg: 335 }
    ];

    const screenPoints = sectors.map(s => {
      const { gx, gy } = polarToGrid(520, s.deg);
      return { name: s.name, pt: isoProject(gx, gy, 0, camera, 1000, 800) };
    });

    screenPoints.sort((a, b) => a.pt.x - b.pt.x);

    // Verify minimum horizontal separation exceeds 180px
    for (let i = 0; i < screenPoints.length - 1; i++) {
      const gap = screenPoints[i + 1].pt.x - screenPoints[i].pt.x;
      expect(gap).toBeGreaterThan(150);
    }
  });
});
