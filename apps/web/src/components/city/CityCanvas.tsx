import React, { useEffect, useRef } from 'react';
import { CityBuilding, CityRoad, CityAgentDrone, CityCamera, TransitionState } from './cityTypes';
import { isoProject } from './isometricMath';

interface CityCanvasProps {
  buildings: CityBuilding[];
  roads: CityRoad[];
  agentFleet: CityAgentDrone[];
  camera: CityCamera;
  transitionState: TransitionState;
  hoveredBuilding: CityBuilding | null;
  lockedBuilding: CityBuilding | null;
  onHoverBuilding: (b: CityBuilding | null) => void;
  onSelectBuilding: (b: CityBuilding) => void;
  onPan: (dx: number, dy: number) => void;
  onZoom: (delta: number) => void;
}

export const CityCanvas: React.FC<CityCanvasProps> = ({
  buildings,
  roads,
  agentFleet,
  camera,
  transitionState,
  hoveredBuilding,
  lockedBuilding,
  onHoverBuilding,
  onSelectBuilding,
  onPan,
  onZoom
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef(0);
  const dragRef = useRef<{ isDragging: boolean; lastX: number; lastY: number }>({
    isDragging: false,
    lastX: 0,
    lastY: 0
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;

    const render = () => {
      frameRef.current++;
      const frame = frameRef.current;
      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);

      // 1. Фоновая атмосфера ядра города
      const centerScreen = isoProject(0, 0, 40, camera, width, height);
      const radGrad = ctx.createRadialGradient(
        centerScreen.x, centerScreen.y, 10,
        centerScreen.x, centerScreen.y, 750 * camera.zoom
      );
      radGrad.addColorStop(0, 'rgba(0, 240, 255, 0.10)');
      radGrad.addColorStop(0.35, 'rgba(139, 92, 246, 0.05)');
      radGrad.addColorStop(0.70, 'rgba(10, 20, 42, 0.03)');
      radGrad.addColorStop(1, 'rgba(2, 5, 14, 0)');
      ctx.fillStyle = radGrad;
      ctx.fillRect(0, 0, width, height);

      // 2. Радиально-концентрическая система
      drawGridAndCircles(ctx, frame, camera, width, height);

      // 3. Форум
      drawForum(ctx, frame, camera, width, height, buildings);

      // 4. Проспекты
      drawRoads(ctx, frame, camera, width, height, roads, buildings);

      // 5. Здания
      drawBuildings(ctx, frame, camera, width, height, buildings, hoveredBuilding, lockedBuilding);

      // 6. Трафик агентов
      drawDrones(ctx, frame, camera, width, height, agentFleet, roads, buildings);

      // 7. Вывески
      drawBadges(ctx, camera, width, height, buildings, hoveredBuilding, lockedBuilding);

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [buildings, roads, agentFleet, camera, hoveredBuilding, lockedBuilding]);

  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = window.innerWidth;
        canvasRef.current.height = window.innerHeight;
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (transitionState !== 'idle') return;
    dragRef.current = { isDragging: true, lastX: e.clientX, lastY: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (transitionState !== 'idle') return;
    if (dragRef.current.isDragging) {
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      onPan(dx, dy);
    } else {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const w = canvasRef.current.width;
      const h = canvasRef.current.height;

      let found: CityBuilding | null = null;
      for (const b of buildings) {
        const top = isoProject(b.gridX, b.gridY, b.height * 0.5, camera, w, h);
        if (Math.hypot(top.x - mx, top.y - my) < 75 * camera.zoom) {
          found = b;
          break;
        }
      }
      onHoverBuilding(found);
    }
  };

  const handleMouseUp = () => {
    dragRef.current.isDragging = false;
  };

  const handleClick = (e: React.MouseEvent) => {
    if (transitionState !== 'idle' || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = canvasRef.current.width;
    const h = canvasRef.current.height;

    for (const b of buildings) {
      const top = isoProject(b.gridX, b.gridY, b.height * 0.5, camera, w, h);
      if (Math.hypot(top.x - mx, top.y - my) < 75 * camera.zoom) {
        onSelectBuilding(b);
        break;
      }
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (transitionState !== 'idle') return;
    e.preventDefault();
    onZoom(e.deltaY > 0 ? -0.1 : 0.1);
  };

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
      onWheel={handleWheel}
      className={`block w-full h-full ${hoveredBuilding ? 'cursor-pointer' : dragRef.current.isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
    />
  );
};

// =========================================================================
// СЕТКА И ОКРУЖНОСТИ
// =========================================================================
function drawGridAndCircles(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number) {
  const gridSize = 2200;
  const step = 60;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.035)';

  for (let g = -gridSize; g <= gridSize; g += step) {
    const p1 = isoProject(g, -gridSize, 0, camera, w, h);
    const p2 = isoProject(g, gridSize, 0, camera, w, h);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    const p3 = isoProject(-gridSize, g, 0, camera, w, h);
    const p4 = isoProject(gridSize, g, 0, camera, w, h);
    ctx.beginPath();
    ctx.moveTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.stroke();
  }

  // Радиальные лучи
  const radialAngles = [0, 30, 45, 60, 90, 115, 120, 150, 180, 185, 210, 225, 240, 265, 270, 300, 315, 330, 335];
  const maxR = 680;
  const origin = isoProject(0, 0, 0, camera, w, h);

  radialAngles.forEach(deg => {
    const rad = (deg * Math.PI) / 180;
    const isSpoke = [115, 185, 265, 335].includes(deg);
    const isMajor = deg % 45 === 0;
    const outerPt = isoProject(Math.cos(rad) * maxR, Math.sin(rad) * maxR, 0, camera, w, h);

    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(outerPt.x, outerPt.y);
    ctx.strokeStyle = isSpoke ? 'rgba(0, 240, 255, 0.28)' : isMajor ? 'rgba(0, 240, 255, 0.10)' : 'rgba(0, 240, 255, 0.04)';
    ctx.lineWidth = (isSpoke ? 2 : isMajor ? 1.5 : 1) * camera.zoom;
    if (!isSpoke) ctx.setLineDash([4 * camera.zoom, 8 * camera.zoom]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (camera.zoom >= 0.65 && isMajor) {
      ctx.font = '600 8px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0, 240, 255, 0.40)';
      ctx.fillText(`RAD-${String(deg).padStart(3, '0')}°`, outerPt.x, outerPt.y);
    }
  });

  drawIsoCircle(ctx, 700, 0, camera, w, h, 'rgba(0, 240, 255, 0.12)', 1.5, [6, 12]);
  drawIsoCircleBand(ctx, 520, 16, camera, w, h, 'rgba(10, 24, 48, 0.90)');
  drawIsoCircle(ctx, 528, 0, camera, w, h, 'rgba(0, 240, 255, 0.40)', 1.5);
  drawIsoCircle(ctx, 512, 0, camera, w, h, 'rgba(0, 240, 255, 0.40)', 1.5);
  drawIsoCircle(ctx, 520, 0, camera, w, h, 'rgba(0, 240, 255, 0.95)', 2.2, [10, 12], -frame * 0.75);

  drawIsoCircleBand(ctx, 345, 10, camera, w, h, 'rgba(8, 20, 42, 0.80)');
  drawIsoCircle(ctx, 350, 0, camera, w, h, 'rgba(139, 92, 246, 0.45)', 1.2);
  drawIsoCircle(ctx, 340, 0, camera, w, h, 'rgba(139, 92, 246, 0.45)', 1.2);
  drawIsoCircle(ctx, 345, 0, camera, w, h, 'rgba(139, 92, 246, 0.85)', 1.8, [8, 10], frame * 0.6);

  drawIsoCircle(ctx, 175, 0, camera, w, h, '#ffd600', 2, [5, 5]);

  if (camera.zoom >= 0.7) {
    ctx.font = '700 9px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    const labelMagnus = isoProject(0, 520, 0, camera, w, h);
    ctx.fillStyle = '#00f0ff';
    ctx.fillText('CIRCULUS MAGNUS • R-520 • SECTOR REGISTRY', labelMagnus.x, labelMagnus.y + 16);

    const labelMedius = isoProject(0, 345, 0, camera, w, h);
    ctx.fillStyle = '#a78bfa';
    ctx.fillText('CIRCULUS MEDIUS • R-345 • VIA ORBITA', labelMedius.x, labelMedius.y + 14);
  }
}

function drawIsoCircle(
  ctx: CanvasRenderingContext2D,
  radius: number,
  z: number,
  camera: CityCamera,
  w: number,
  h: number,
  color: string,
  width: number,
  dash: number[] = [],
  dashOffset: number = 0
) {
  const segs = 72;
  ctx.beginPath();
  for (let i = 0; i <= segs; i++) {
    const angle = (i / segs) * Math.PI * 2;
    const pt = isoProject(Math.cos(angle) * radius, Math.sin(angle) * radius, z, camera, w, h);
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  }
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width * camera.zoom;
  if (dash.length > 0) {
    ctx.setLineDash(dash.map(d => d * camera.zoom));
    ctx.lineDashOffset = dashOffset;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawIsoCircleBand(
  ctx: CanvasRenderingContext2D,
  radius: number,
  bandWidth: number,
  camera: CityCamera,
  w: number,
  h: number,
  fillColor: string
) {
  const segs = 72;
  const rInner = radius - bandWidth / 2;
  const rOuter = radius + bandWidth / 2;

  ctx.beginPath();
  for (let i = 0; i <= segs; i++) {
    const angle = (i / segs) * Math.PI * 2;
    const pt = isoProject(Math.cos(angle) * rOuter, Math.sin(angle) * rOuter, 0, camera, w, h);
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  }
  for (let i = segs; i >= 0; i--) {
    const angle = (i / segs) * Math.PI * 2;
    const pt = isoProject(Math.cos(angle) * rInner, Math.sin(angle) * rInner, 0, camera, w, h);
    ctx.lineTo(pt.x, pt.y);
  }
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
}

function drawForum(
  ctx: CanvasRenderingContext2D,
  frame: number,
  camera: CityCamera,
  w: number,
  h: number,
  buildings: CityBuilding[]
) {
  const fw = 490;
  const fd = 430;
  const fh = 16;

  const p3 = isoProject(-fw/2, fd/2, 0, camera, w, h);
  const p2 = isoProject(fw/2, fd/2, 0, camera, w, h);
  const p1 = isoProject(fw/2, -fd/2, 0, camera, w, h);

  const t3 = isoProject(-fw/2, fd/2, fh, camera, w, h);
  const t2 = isoProject(fw/2, fd/2, fh, camera, w, h);
  const t1 = isoProject(fw/2, -fd/2, fh, camera, w, h);
  const t0 = isoProject(-fw/2, -fd/2, fh, camera, w, h);

  ctx.beginPath();
  ctx.moveTo(p3.x, p3.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(t2.x, t2.y);
  ctx.lineTo(t3.x, t3.y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(10, 20, 42, 0.96)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(p2.x, p2.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(t1.x, t1.y);
  ctx.lineTo(t2.x, t2.y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(6, 14, 30, 0.96)';
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(t0.x, t0.y);
  ctx.lineTo(t1.x, t1.y);
  ctx.lineTo(t2.x, t2.y);
  ctx.lineTo(t3.x, t3.y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(14, 28, 56, 0.98)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 214, 0, 0.65)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Via Sacra
  const lib = buildings.find(b => b.id === 'minsk_library');
  const pan = buildings.find(b => b.id === 'agent_pantheon');
  if (lib && pan) {
    const sLib = isoProject(lib.gridX, lib.gridY, fh + 1, camera, w, h);
    const sPan = isoProject(pan.gridX, pan.gridY, fh + 1, camera, w, h);

    ctx.beginPath();
    ctx.moveTo(sLib.x, sLib.y);
    ctx.lineTo(sPan.x, sPan.y);
    ctx.lineWidth = 24 * camera.zoom;
    ctx.strokeStyle = 'rgba(255, 214, 0, 0.25)';
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(sLib.x, sLib.y);
    ctx.lineTo(sPan.x, sPan.y);
    ctx.lineWidth = 2.5 * camera.zoom;
    ctx.strokeStyle = '#ffd600';
    ctx.setLineDash([8 * camera.zoom, 8 * camera.zoom]);
    ctx.lineDashOffset = -frame * 0.75;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Milliarium Aureum
  const milBase = isoProject(0, 0, fh, camera, w, h);
  const milTop = isoProject(0, 0, fh + 32, camera, w, h);
  ctx.beginPath();
  ctx.moveTo(milBase.x, milBase.y);
  ctx.lineTo(milTop.x, milTop.y);
  ctx.lineWidth = 5 * camera.zoom;
  ctx.strokeStyle = '#ffd600';
  ctx.stroke();

  ctx.fillStyle = '#ffd600';
  ctx.beginPath();
  ctx.arc(milTop.x, milTop.y, 5 * camera.zoom, 0, Math.PI * 2);
  ctx.fill();
}

function drawRoads(
  ctx: CanvasRenderingContext2D,
  frame: number,
  camera: CityCamera,
  w: number,
  h: number,
  roads: CityRoad[],
  buildings: CityBuilding[]
) {
  roads.forEach(road => {
    if (road.type === 'ring') return;
    const bA = buildings.find(b => b.id === road.from);
    const bB = buildings.find(b => b.id === road.to);
    if (!bA || !bB) return;

    const sA = isoProject(bA.gridX, bA.gridY, 0, camera, w, h);
    const sB = isoProject(bB.gridX, bB.gridY, 0, camera, w, h);

    ctx.beginPath();
    ctx.moveTo(sA.x, sA.y);
    ctx.lineTo(sB.x, sB.y);
    ctx.lineWidth = (road.width + 4) * camera.zoom;
    ctx.strokeStyle = 'rgba(10, 25, 48, 0.94)';
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(sA.x, sA.y);
    ctx.lineTo(sB.x, sB.y);
    ctx.lineWidth = road.width * camera.zoom;
    ctx.strokeStyle = road.type === 'forum' ? 'rgba(255, 214, 0, 0.40)' : 'rgba(0, 240, 255, 0.35)';
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(sA.x, sA.y);
    ctx.lineTo(sB.x, sB.y);
    ctx.lineWidth = 2.5 * camera.zoom;
    ctx.strokeStyle = road.type === 'forum' ? '#ffd600' : '#00f0ff';
    ctx.setLineDash([8 * camera.zoom, 8 * camera.zoom]);
    ctx.lineDashOffset = -frame * 0.85;
    ctx.stroke();
    ctx.setLineDash([]);
  });
}

// =========================================================================
// ДИСПЕТЧЕР И 12+ ПРОЦЕДУРНЫХ РЕНДЕРЕРОВ ЗДАНИЙ
// =========================================================================
function drawBuildings(
  ctx: CanvasRenderingContext2D,
  frame: number,
  camera: CityCamera,
  w: number,
  h: number,
  buildings: CityBuilding[],
  hovered: CityBuilding | null,
  locked: CityBuilding | null
) {
  const sorted = [...buildings].sort((a, b) => (a.gridX + a.gridY) - (b.gridX + b.gridY));
  sorted.forEach(b => {
    const active = hovered === b || locked === b;
    switch (b.shape) {
      case 'rhombicuboctahedron':
        drawLibrary3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'temple_nexus':
        drawPantheon3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'lab_observatory':
        drawLab3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'curia_senate':
        drawConsensus3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'stealth_praetorium':
        drawSecurity3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'scaffold_foundry':
        drawFoundry3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'trading_bourse':
        drawBourse3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'neural_academy':
        drawAcademy3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'agora_amphitheater':
        drawAgora3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'quantum_telemetry':
        drawRelay3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'chronos_vault':
        drawChronos3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'biotech_incubator':
        drawIncubator3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'colosseum_arena':
        drawColosseum3D(ctx, frame, camera, w, h, b, active);
        break;
      case 'matrix_datacenter':
        drawDatacenter3D(ctx, frame, camera, w, h, b, active);
        break;
      default:
        drawLab3D(ctx, frame, camera, w, h, b, active);
    }
  });
}

// 1. Библиотека Знаний (ромбокубооктаэдр)
function drawLibrary3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const r = b.width * 0.52;
  const baseH = 26;
  const totalH = b.height;

  for (let tier = 0; tier < 3; tier++) {
    const tr = r * (1.50 - tier * 0.16);
    const th = baseH * ((tier + 1) / 3);
    ctx.fillStyle = active ? 'rgba(24, 44, 80, 0.95)' : 'rgba(12, 24, 46, 0.92)';
    ctx.strokeStyle = active ? '#ffd600' : 'rgba(255, 214, 0, 0.45)';
    ctx.lineWidth = active ? 2 : 1;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const pt = isoProject(cx + Math.cos(angle) * tr, cy + Math.sin(angle) * tr, th, camera, w, h);
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  const eqLowZ = baseH + (totalH - baseH) * 0.42;
  const eqUpZ = baseH + (totalH - baseH) * 0.58;
  const topZ = totalH;

  const lowEqPoints: { x: number; y: number }[] = [];
  const upEqPoints: { x: number; y: number }[] = [];

  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + (Math.PI / 8);
    lowEqPoints.push(isoProject(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, eqLowZ, camera, w, h));
    upEqPoints.push(isoProject(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, eqUpZ, camera, w, h));
  }

  for (let i = 0; i < 8; i++) {
    const next = (i + 1) % 8;
    ctx.beginPath();
    ctx.moveTo(lowEqPoints[i].x, lowEqPoints[i].y);
    ctx.lineTo(lowEqPoints[next].x, lowEqPoints[next].y);
    ctx.lineTo(upEqPoints[next].x, upEqPoints[next].y);
    ctx.lineTo(upEqPoints[i].x, upEqPoints[i].y);
    ctx.closePath();
    ctx.fillStyle = active ? 'rgba(0, 240, 255, 0.45)' : 'rgba(16, 42, 80, 0.95)';
    ctx.fill();
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  const spireTop = isoProject(cx, cy, topZ + 32, camera, w, h);
  ctx.beginPath();
  ctx.moveTo(isoProject(cx, cy, topZ, camera, w, h).x, isoProject(cx, cy, topZ, camera, w, h).y);
  ctx.lineTo(spireTop.x, spireTop.y);
  ctx.strokeStyle = '#00f0ff';
  ctx.lineWidth = 2.5 * camera.zoom;
  ctx.stroke();

  ctx.fillStyle = '#10b981';
  ctx.beginPath();
  ctx.arc(spireTop.x, spireTop.y, 5 * camera.zoom, 0, Math.PI * 2);
  ctx.fill();
}

// 2. Пантеон Агентов (ротонда и окулус)
function drawPantheon3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const r = b.width * 0.48;
  const drumH = b.height * 0.65;

  const segs = 16;
  for (let i = 0; i < segs; i++) {
    const a1 = (i / segs) * Math.PI * 2;
    const a2 = ((i + 1) / segs) * Math.PI * 2;
    const b1 = isoProject(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, 12, camera, w, h);
    const b2 = isoProject(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, 12, camera, w, h);
    const t2 = isoProject(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, drumH, camera, w, h);
    const t1 = isoProject(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, drumH, camera, w, h);

    ctx.beginPath();
    ctx.moveTo(b1.x, b1.y);
    ctx.lineTo(b2.x, b2.y);
    ctx.lineTo(t2.x, t2.y);
    ctx.lineTo(t1.x, t1.y);
    ctx.closePath();
    ctx.fillStyle = active ? 'rgba(129, 140, 248, 0.65)' : 'rgba(20, 34, 70, 0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(129, 140, 248, 0.35)';
    ctx.stroke();
  }

  const oculusPt = isoProject(cx, cy, drumH + 42, camera, w, h);
  ctx.strokeStyle = '#ffd600';
  ctx.lineWidth = 2.5 * camera.zoom;
  ctx.beginPath();
  ctx.ellipse(oculusPt.x, oculusPt.y, 8 * camera.zoom, 4 * camera.zoom, 0, 0, Math.PI * 2);
  ctx.stroke();
}

// 3. Обсерватория (lab_observatory)
function drawLab3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const width = b.width;
  const depth = b.depth;
  const height = b.height;

  const p3 = isoProject(cx - width/2, cy + depth/2, 0, camera, w, h);
  const p2 = isoProject(cx + width/2, cy + depth/2, 0, camera, w, h);
  const t2 = isoProject(cx + width/2, cy + depth/2, height * 0.7, camera, w, h);
  const t3 = isoProject(cx - width/2, cy + depth/2, height * 0.7, camera, w, h);

  ctx.beginPath();
  ctx.moveTo(p3.x, p3.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(t2.x, t2.y);
  ctx.lineTo(t3.x, t3.y);
  ctx.closePath();
  ctx.fillStyle = active ? 'rgba(0, 240, 255, 0.4)' : 'rgba(10, 24, 48, 0.95)';
  ctx.fill();
  ctx.strokeStyle = '#00f0ff';
  ctx.stroke();

  const dishPt = isoProject(cx, cy, height + 24, camera, w, h);
  ctx.beginPath();
  ctx.ellipse(dishPt.x, dishPt.y, 14 * camera.zoom, 6 * camera.zoom, frame * 0.02, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
}

// 4. Курия / Сенат (curia_senate)
function drawConsensus3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const r = b.width * 0.48;
  const height = b.height;

  for (let i = 1; i <= 4; i++) {
    const a1 = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const a2 = ((i + 1) / 8) * Math.PI * 2 + Math.PI / 8;
    const b1 = isoProject(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, 0, camera, w, h);
    const b2 = isoProject(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, 0, camera, w, h);
    const t2 = isoProject(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, height * 0.7, camera, w, h);
    const t1 = isoProject(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, height * 0.7, camera, w, h);

    ctx.beginPath();
    ctx.moveTo(b1.x, b1.y);
    ctx.lineTo(b2.x, b2.y);
    ctx.lineTo(t2.x, t2.y);
    ctx.lineTo(t1.x, t1.y);
    ctx.closePath();
    ctx.fillStyle = active ? 'rgba(255, 214, 0, 0.4)' : 'rgba(24, 22, 10, 0.95)';
    ctx.fill();
    ctx.strokeStyle = '#ffd600';
    ctx.stroke();
  }

  const ringCenter = isoProject(cx, cy, height + 22, camera, w, h);
  ctx.beginPath();
  ctx.ellipse(ringCenter.x, ringCenter.y, 24 * camera.zoom, 10 * camera.zoom, frame * 0.03, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffd600';
  ctx.stroke();
}

// 5. Преторий (stealth_praetorium)
function drawSecurity3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const width = b.width;
  const depth = b.depth;
  const height = b.height;

  const p3 = isoProject(cx - width/2, cy + depth/2, 0, camera, w, h);
  const p2 = isoProject(cx + width/2, cy + depth/2, 0, camera, w, h);
  const t2 = isoProject(cx + width*0.4, cy + depth*0.4, height, camera, w, h);
  const t3 = isoProject(cx - width*0.4, cy + depth*0.4, height, camera, w, h);

  ctx.beginPath();
  ctx.moveTo(p3.x, p3.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(t2.x, t2.y);
  ctx.lineTo(t3.x, t3.y);
  ctx.closePath();
  ctx.fillStyle = active ? 'rgba(255, 42, 95, 0.45)' : 'rgba(32, 10, 18, 0.95)';
  ctx.fill();
  ctx.strokeStyle = '#ff2a5f';
  ctx.stroke();
}

// 6. Стройка (scaffold_foundry)
function drawFoundry3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const height = b.height;

  const craneBase = isoProject(cx + 25, cy + 20, 14, camera, w, h);
  const craneTowerTop = isoProject(cx + 25, cy + 20, height + 20, camera, w, h);

  ctx.beginPath();
  ctx.moveTo(craneBase.x, craneBase.y);
  ctx.lineTo(craneTowerTop.x, craneTowerTop.y);
  ctx.lineWidth = 4 * camera.zoom;
  ctx.strokeStyle = '#fbbf24';
  ctx.stroke();

  const craneArmAngle = frame * 0.025;
  const armLen = 38 * camera.zoom;
  const craneArmEnd = {
    x: craneTowerTop.x + Math.cos(craneArmAngle) * armLen,
    y: craneTowerTop.y + Math.sin(craneArmAngle) * (armLen * 0.5)
  };

  ctx.beginPath();
  ctx.moveTo(craneTowerTop.x, craneTowerTop.y);
  ctx.lineTo(craneArmEnd.x, craneArmEnd.y);
  ctx.lineWidth = 2.5 * camera.zoom;
  ctx.strokeStyle = '#ffd600';
  ctx.stroke();
}

// 7. Алгоритмическая Биржа (trading_bourse)
function drawBourse3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const r = b.width * 0.45;
  const hTotal = b.height;

  // Двойная винтовая башня
  const steps = 14;
  for (let i = 0; i < steps; i++) {
    const z = (i / steps) * hTotal;
    const a = (i * 0.45) + frame * 0.02;
    const pt1 = isoProject(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z, camera, w, h);
    const pt2 = isoProject(cx + Math.cos(a + Math.PI) * r, cy + Math.sin(a + Math.PI) * r, z, camera, w, h);

    ctx.fillStyle = i % 2 === 0 ? '#10b981' : '#34d399';
    ctx.beginPath();
    ctx.arc(pt1.x, pt1.y, 3 * camera.zoom, 0, Math.PI * 2);
    ctx.arc(pt2.x, pt2.y, 3 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
  }

  // Центральный столб
  const top = isoProject(cx, cy, hTotal + 25, camera, w, h);
  const base = isoProject(cx, cy, 0, camera, w, h);
  ctx.beginPath();
  ctx.moveTo(base.x, base.y);
  ctx.lineTo(top.x, top.y);
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 3 * camera.zoom;
  ctx.stroke();

  // Парящий золотой ромб прибыли
  ctx.fillStyle = '#ffd600';
  ctx.beginPath();
  ctx.arc(top.x, top.y, 6 * camera.zoom, 0, Math.PI * 2);
  ctx.fill();
}

// 8. Нейронная Академия (neural_academy)
function drawAcademy3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const baseW = b.width;
  const hTotal = b.height;

  // Ступенчатый зиккурат
  for (let tier = 0; tier < 3; tier++) {
    const tw = baseW * (1 - tier * 0.25);
    const z = (tier * hTotal) / 3;
    const p3 = isoProject(cx - tw/2, cy + tw/2, z, camera, w, h);
    const p2 = isoProject(cx + tw/2, cy + tw/2, z, camera, w, h);
    const t2 = isoProject(cx + tw/2, cy + tw/2, z + hTotal/3.5, camera, w, h);
    const t3 = isoProject(cx - tw/2, cy + tw/2, z + hTotal/3.5, camera, w, h);

    ctx.beginPath();
    ctx.moveTo(p3.x, p3.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(t2.x, t2.y);
    ctx.lineTo(t3.x, t3.y);
    ctx.closePath();
    ctx.fillStyle = active ? 'rgba(168, 85, 247, 0.45)' : 'rgba(28, 14, 48, 0.95)';
    ctx.fill();
    ctx.strokeStyle = '#a855f7';
    ctx.stroke();
  }

  // Нейронная сфера в зените
  const apex = isoProject(cx, cy, hTotal + 26, camera, w, h);
  ctx.fillStyle = '#c084fc';
  ctx.beginPath();
  ctx.arc(apex.x, apex.y, 7 * camera.zoom, 0, Math.PI * 2);
  ctx.fill();
}

// 9. Агора / Амфитеатр (agora_amphitheater)
function drawAgora3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const r = b.width * 0.55;

  // Полукруглые ступенчатые ярусы
  for (let tier = 0; tier < 4; tier++) {
    const tr = r * (0.4 + tier * 0.18);
    const tz = tier * 9;
    ctx.beginPath();
    for (let a = 0; a <= 12; a++) {
      const rad = Math.PI * (0.8 + (a / 12) * 1.4);
      const pt = isoProject(cx + Math.cos(rad) * tr, cy + Math.sin(rad) * tr, tz, camera, w, h);
      if (a === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.strokeStyle = active ? '#ffffff' : '#f97316';
    ctx.lineWidth = 2 * camera.zoom;
    ctx.stroke();
  }

  // Центральная трибуна оратора
  const center = isoProject(cx, cy, 14, camera, w, h);
  ctx.fillStyle = '#fb923c';
  ctx.beginPath();
  ctx.arc(center.x, center.y, 5 * camera.zoom, 0, Math.PI * 2);
  ctx.fill();
}

// 10. Межсетевой Ретранслятор (quantum_telemetry)
function drawRelay3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const hTotal = b.height + 35;

  const base = isoProject(cx, cy, 0, camera, w, h);
  const tip = isoProject(cx, cy, hTotal, camera, w, h);

  // Решетчатая триангуляционная мачта
  ctx.beginPath();
  ctx.moveTo(base.x, base.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 3 * camera.zoom;
  ctx.stroke();

  // 3 антенные тарелки на ярусах
  [0.4, 0.7, 0.95].forEach((pct, idx) => {
    const pt = isoProject(cx, cy, hTotal * pct, camera, w, h);
    ctx.beginPath();
    ctx.ellipse(pt.x, pt.y, (12 - idx * 3) * camera.zoom, 5 * camera.zoom, (frame * 0.02) + idx, 0, Math.PI * 2);
    ctx.strokeStyle = '#00f0ff';
    ctx.stroke();
  });

  // Лазерный луч в зенит
  const skyBeam = isoProject(cx, cy, hTotal + 70, camera, w, h);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(skyBeam.x, skyBeam.y);
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
  ctx.lineWidth = 2 * camera.zoom;
  ctx.stroke();
}

// 11. Хронос-Архив (chronos_vault)
function drawChronos3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const s = b.width * 0.45;
  const hTotal = b.height * 0.8;

  // Монолитный куб
  const p3 = isoProject(cx - s, cy + s, 0, camera, w, h);
  const p2 = isoProject(cx + s, cy + s, 0, camera, w, h);
  const t2 = isoProject(cx + s, cy + s, hTotal, camera, w, h);
  const t3 = isoProject(cx - s, cy + s, hTotal, camera, w, h);

  ctx.beginPath();
  ctx.moveTo(p3.x, p3.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(t2.x, t2.y);
  ctx.lineTo(t3.x, t3.y);
  ctx.closePath();
  ctx.fillStyle = active ? 'rgba(99, 102, 241, 0.45)' : 'rgba(14, 16, 38, 0.96)';
  ctx.fill();
  ctx.strokeStyle = '#6366f1';
  ctx.stroke();

  // Вращающиеся шестерни времени
  const dial = isoProject(cx, cy, hTotal + 18, camera, w, h);
  ctx.beginPath();
  ctx.ellipse(dial.x, dial.y, 16 * camera.zoom, 7 * camera.zoom, frame * 0.02, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffd600';
  ctx.stroke();
}

// 12. Био-Инкубатор (biotech_incubator)
function drawIncubator3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const r = b.width * 0.42;
  const hTotal = b.height;

  // Стеклянная капсула
  const base = isoProject(cx, cy, 0, camera, w, h);
  const top = isoProject(cx, cy, hTotal, camera, w, h);

  ctx.beginPath();
  ctx.ellipse(base.x, base.y, r * 1.2 * camera.zoom, r * 0.6 * camera.zoom, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(236, 72, 153, 0.2)';
  ctx.fill();
  ctx.strokeStyle = '#ec4899';
  ctx.stroke();

  // ДНК-спираль внутри
  for (let z = 10; z < hTotal; z += 12) {
    const a = (z * 0.15) + frame * 0.04;
    const pt = isoProject(cx + Math.cos(a) * (r * 0.6), cy + Math.sin(a) * (r * 0.6), z, camera, w, h);
    ctx.fillStyle = '#f472b6';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 2.5 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 13. Колизей (colosseum_arena)
function drawColosseum3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const rX = b.width * 0.55;
  const rY = b.depth * 0.45;
  const hTotal = b.height * 0.65;

  // Внешний овальный ярус
  for (let tier = 0; tier < 2; tier++) {
    const tz = tier * 18;
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const pt = isoProject(cx + Math.cos(a) * rX, cy + Math.sin(a) * rY, tz, camera, w, h);
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.strokeStyle = active ? '#ffffff' : '#ef4444';
    ctx.lineWidth = 2 * camera.zoom;
    ctx.stroke();
  }

  // Центральная боевая арена
  const arena = isoProject(cx, cy, 6, camera, w, h);
  ctx.fillStyle = 'rgba(239, 68, 68, 0.35)';
  ctx.beginPath();
  ctx.ellipse(arena.x, arena.y, 16 * camera.zoom, 8 * camera.zoom, 0, 0, Math.PI * 2);
  ctx.fill();
}

// 14. Матричный Датацентр (matrix_datacenter)
function drawDatacenter3D(ctx: CanvasRenderingContext2D, frame: number, camera: CityCamera, w: number, h: number, b: CityBuilding, active: boolean) {
  const cx = b.gridX;
  const cy = b.gridY;
  const s = 16;
  const hTotal = b.height * 0.75;

  // 4 серверные стойки
  const offsets = [
    { x: -s, y: -s },
    { x: s, y: -s },
    { x: -s, y: s },
    { x: s, y: s }
  ];

  offsets.forEach((off, idx) => {
    const p3 = isoProject(cx + off.x - 8, cy + off.y + 8, 0, camera, w, h);
    const p2 = isoProject(cx + off.x + 8, cy + off.y + 8, 0, camera, w, h);
    const t2 = isoProject(cx + off.x + 8, cy + off.y + 8, hTotal, camera, w, h);
    const t3 = isoProject(cx + off.x - 8, cy + off.y + 8, hTotal, camera, w, h);

    ctx.beginPath();
    ctx.moveTo(p3.x, p3.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(t2.x, t2.y);
    ctx.lineTo(t3.x, t3.y);
    ctx.closePath();
    ctx.fillStyle = active ? 'rgba(132, 204, 22, 0.45)' : 'rgba(16, 28, 12, 0.95)';
    ctx.fill();
    ctx.strokeStyle = '#84cc16';
    ctx.stroke();

    // Светодиоды I/O активности
    if ((frame + idx * 4) % 10 < 5) {
      const led = isoProject(cx + off.x, cy + off.y + 8, hTotal * 0.6, camera, w, h);
      ctx.fillStyle = '#00f0ff';
      ctx.beginPath();
      ctx.arc(led.x, led.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

// Дроны агентов
function drawDrones(
  ctx: CanvasRenderingContext2D,
  frame: number,
  camera: CityCamera,
  w: number,
  h: number,
  agentFleet: CityAgentDrone[],
  roads: CityRoad[],
  buildings: CityBuilding[]
) {
  agentFleet.forEach(agent => {
    agent.progress += agent.speed;
    if (agent.progress > 1) agent.progress = 0;
    if (agent.progress < 0) agent.progress = 1;

    const road = roads[agent.roadIdx];
    if (!road) return;

    let screenPos: { x: number; y: number };
    if (road.type === 'ring' && road.r && road.aStart !== undefined && road.aEnd !== undefined) {
      const angleDeg = road.aStart + (road.aEnd - road.aStart) * agent.progress;
      const rad = (angleDeg * Math.PI) / 180;
      screenPos = isoProject(road.r * Math.cos(rad), road.r * Math.sin(rad), 8, camera, w, h);
    } else {
      const bA = buildings.find(b => b.id === road.from);
      const bB = buildings.find(b => b.id === road.to);
      if (!bA || !bB) return;
      const curX = bA.gridX + (bB.gridX - bA.gridX) * agent.progress;
      const curY = bA.gridY + (bB.gridY - bA.gridY) * agent.progress;
      screenPos = isoProject(curX, curY, 8, camera, w, h);
    }

    ctx.fillStyle = agent.color;
    ctx.shadowColor = agent.color;
    ctx.shadowBlur = 12 * camera.zoom;
    ctx.beginPath();
    ctx.arc(screenPos.x, screenPos.y, 4.5 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  });
}

// Вывески над зданиями
function drawBadges(
  ctx: CanvasRenderingContext2D,
  camera: CityCamera,
  w: number,
  h: number,
  buildings: CityBuilding[],
  hovered: CityBuilding | null,
  locked: CityBuilding | null
) {
  if (camera.zoom < 0.42) return;

  buildings.forEach(b => {
    const active = hovered === b || locked === b;
    const topPt = isoProject(b.gridX, b.gridY, b.height + 26, camera, w, h);
    const pinLen = 22 * camera.zoom;
    const badgeY = topPt.y - pinLen;

    ctx.beginPath();
    ctx.moveTo(topPt.x, topPt.y);
    ctx.lineTo(topPt.x, badgeY);
    ctx.strokeStyle = active ? '#ffffff' : b.color;
    ctx.lineWidth = 1.5 * camera.zoom;
    ctx.stroke();

    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(topPt.x, topPt.y, 3 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();

    const title = b.name;
    const sub = `${b.badge} • ${b.messages} msgs`;

    ctx.font = '700 11px JetBrains Mono, monospace';
    const titleW = ctx.measureText(title).width;
    ctx.font = '500 9px JetBrains Mono, monospace';
    const subW = ctx.measureText(sub).width;

    const boxW = Math.max(titleW, subW) + 26;
    const boxH = 34;
    const boxX = topPt.x - boxW / 2;
    const boxTop = badgeY - boxH;

    ctx.save();
    ctx.fillStyle = active ? 'rgba(12, 24, 48, 0.96)' : 'rgba(6, 14, 28, 0.92)';
    ctx.shadowColor = b.color;
    ctx.shadowBlur = active ? 16 : 8;

    ctx.beginPath();
    ctx.roundRect(boxX, boxTop, boxW, boxH, 6);
    ctx.fill();

    ctx.strokeStyle = active ? '#ffffff' : b.color;
    ctx.lineWidth = active ? 2 : 1;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#10b981';
    ctx.beginPath();
    ctx.arc(boxX + 11, boxTop + 13, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '700 11px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = active ? '#ffffff' : '#f8fafc';
    ctx.fillText(title, boxX + 20, boxTop + 15);

    ctx.font = '500 8.5px JetBrains Mono, monospace';
    ctx.fillStyle = b.color;
    ctx.fillText(sub, boxX + 20, boxTop + 27);

    ctx.restore();
  });
}
