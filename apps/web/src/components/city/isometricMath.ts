import { CityCamera } from './cityTypes';

export function isoProject(
  gx: number,
  gy: number,
  gz: number = 0,
  camera: CityCamera,
  viewWidth: number,
  viewHeight: number
) {
  const isoX = (gx - gy) * 0.866025;
  const isoY = (gx + gy) * 0.5 - gz;
  return {
    x: (viewWidth / 2) + (isoX - camera.focalX) * camera.zoom,
    y: (viewHeight / 2) + (isoY - camera.focalY) * camera.zoom
  };
}

export function polarToGrid(radius: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    gx: radius * Math.cos(rad),
    gy: radius * Math.sin(rad)
  };
}
