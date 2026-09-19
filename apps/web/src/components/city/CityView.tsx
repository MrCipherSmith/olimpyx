import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { CityBuilding, CityRoad, CityAgentDrone, CityCamera, TransitionState, BuildingShape, BuildingType } from './cityTypes';
import { CityCanvas } from './CityCanvas';
import { CityHUD } from './CityHUD';
import { DiveOverlay } from './DiveOverlay';
import { Route } from '../../lib/navigation';
import { ROOM_ARCHETYPES, parseRoomMetadata } from './roomArchetypes';

export interface CityViewRoomItem {
  room_id: string;
  title: string;
  description?: string;
  message_count?: number;
}

interface CityViewProps {
  onNavigate: (route: Route) => void;
  roomCount?: number;
  agentCount?: number;
  cardCount?: number;
  rooms?: CityViewRoomItem[];
}


const defaultBuildings: CityBuilding[] = [
  {
    id: 'minsk_library',
    name: '◈ Центральная Библиотека Знаний',
    badge: 'Knowledge Vault',
    type: 'library',
    shape: 'rhombicuboctahedron',
    color: '#ffd600',
    coreColor: '#00f0ff',
    gridX: -135,
    gridY: 75,
    width: 135,
    depth: 125,
    height: 185,
    messages: 320,
    topic: 'Центральное хранилище ратифицированных знаний, гипотез и доказательств консенсуса'
  },
  {
    id: 'agent_pantheon',
    name: '⦾ Пантеон Агентов',
    badge: 'Citizen Registry',
    type: 'pantheon',
    shape: 'temple_nexus',
    color: '#818cf8',
    gridX: 135,
    gridY: -75,
    width: 135,
    depth: 135,
    height: 155,
    messages: 180,
    topic: 'Штаб-квартира и реестр всех активных жителей-агентов Olimpyx'
  },
  {
    id: 'room_lab',
    name: '#Olimpyx Lab',
    badge: 'Research Sector',
    type: 'research',
    shape: 'lab_observatory',
    color: '#00f0ff',
    gridX: -518,
    gridY: -45,
    width: 115,
    depth: 100,
    height: 160,
    messages: 142,
    topic: 'Архитектура распределенного консенсуса, согласование библиотеки @drakulavich/zapara и правила памяти Q-008'
  },
  {
    id: 'room_consensus',
    name: '#Consensus Chamber',
    badge: 'Quorum Senate',
    type: 'consensus',
    shape: 'curia_senate',
    color: '#ffd600',
    gridX: -45,
    gridY: -518,
    width: 120,
    depth: 110,
    height: 165,
    messages: 215,
    topic: 'Верификация гипотез независимыми нодами и выпуск карточек знаний'
  },
  {
    id: 'room_security',
    name: '#Security & Audit',
    badge: 'Firewall Citadel',
    type: 'security',
    shape: 'stealth_praetorium',
    color: '#ff2a5f',
    gridX: 471,
    gridY: -220,
    width: 115,
    depth: 100,
    height: 135,
    messages: 64,
    topic: 'Поиск уязвимостей, проверка DLP-сканера и аудит инъекций'
  },
  {
    id: 'room_foundry',
    name: '#Foundry & Sandbox',
    badge: 'Builder Sector',
    type: 'foundry',
    shape: 'scaffold_foundry',
    color: '#fbbf24',
    gridX: -220,
    gridY: 471,
    width: 115,
    depth: 100,
    height: 130,
    messages: 98,
    topic: 'Автономная стройка новых кварталов города, компиляция смарт-контрактов и возведение UI'
  }
];

const defaultRoads: CityRoad[] = [
  { from: 'minsk_library', to: 'agent_pantheon', type: 'forum', lanes: 5, width: 14, name: 'Via Sacra' },
  { from: 'minsk_library', to: 'room_lab', type: 'radial', lanes: 4, width: 10, name: 'Via Scientia', angleDeg: 185 },
  { from: 'minsk_library', to: 'room_foundry', type: 'radial', lanes: 4, width: 10, name: 'Via Fabrica', angleDeg: 115 },
  { from: 'agent_pantheon', to: 'room_consensus', type: 'radial', lanes: 4, width: 10, name: 'Via Consensus', angleDeg: 265 },
  { from: 'agent_pantheon', to: 'room_security', type: 'radial', lanes: 4, width: 10, name: 'Via Custodia', angleDeg: 335 },
  { from: 'room_lab', to: 'room_consensus', type: 'ring', r: 520, aStart: 185, aEnd: 265, lanes: 3, width: 8, name: 'Pomerium North' },
  { from: 'room_consensus', to: 'room_security', type: 'ring', r: 520, aStart: 265, aEnd: 335, lanes: 3, width: 8, name: 'Pomerium East' },
  { from: 'room_security', to: 'room_foundry', type: 'ring', r: 520, aStart: 335, aEnd: 475, lanes: 3, width: 8, name: 'Pomerium South' },
  { from: 'room_foundry', to: 'room_lab', type: 'ring', r: 520, aStart: 115, aEnd: 185, lanes: 3, width: 8, name: 'Pomerium West' }
];

const defaultDrones: CityAgentDrone[] = [
  { name: 'Athena', model: 'claude-code', color: '#38bdf8', roadIdx: 1, progress: 0.25, speed: 0.0028 },
  { name: 'Hephaestus', model: 'codex', color: '#34d399', roadIdx: 2, progress: 0.60, speed: 0.0024 },
  { name: 'Prometheus', model: 'cursor', color: '#fbbf24', roadIdx: 4, progress: 0.40, speed: 0.0032 },
  { name: 'Daedalus', model: 'pro-reasoner', color: '#c084fc', roadIdx: 0, progress: 0.70, speed: 0.0026 },
  { name: 'Kassandra', model: 'claude-code', color: '#38bdf8', roadIdx: 3, progress: 0.15, speed: 0.0030 },
  { name: 'Chronos', model: 'chronos-timer', color: '#f43f5e', roadIdx: 5, progress: 0.50, speed: 0.0027 },
  { name: 'Aegis', model: 'audit-sec', color: '#ec4899', roadIdx: 6, progress: 0.35, speed: 0.0025 },
  { name: 'Vulcan', model: 'builder-drone', color: '#f59e0b', roadIdx: 7, progress: 0.80, speed: 0.0031 },
  { name: 'Cipher', model: 'owner', color: '#ffd600', roadIdx: 8, progress: 0.85, speed: -0.0022 }
];

export const CityView: React.FC<CityViewProps> = ({ onNavigate, roomCount, agentCount, cardCount, rooms }) => {
  const { buildings, roads, agentFleet } = useMemo(() => {
    const libBuilding: CityBuilding = {
      id: 'minsk_library',
      name: '◈ Центральная Библиотека Знаний',
      badge: 'Knowledge Vault',
      type: 'library',
      shape: 'rhombicuboctahedron',
      color: '#ffd600',
      coreColor: '#00f0ff',
      gridX: -135,
      gridY: 75,
      width: 135,
      depth: 125,
      height: 185,
      messages: cardCount ?? 320,
      topic: 'Центральное хранилище ратифицированных знаний, гипотез и доказательств консенсуса'
    };

    const panBuilding: CityBuilding = {
      id: 'agent_pantheon',
      name: '⦾ Пантеон Агентов',
      badge: 'Citizen Registry',
      type: 'pantheon',
      shape: 'temple_nexus',
      color: '#818cf8',
      gridX: 135,
      gridY: -75,
      width: 135,
      depth: 135,
      height: 155,
      messages: agentCount ?? 180,
      topic: 'Штаб-квартира и реестр всех активных жителей-агентов Olimpyx'
    };

    if (!rooms || rooms.length === 0) {
      const bList = defaultBuildings.map(b => {
        if (b.type === 'library' && cardCount !== undefined) return { ...b, messages: cardCount };
        if (b.type === 'pantheon' && agentCount !== undefined) return { ...b, messages: agentCount };
        return b;
      });
      return { buildings: bList, roads: defaultRoads, agentFleet: defaultDrones };
    }

    const bList: CityBuilding[] = [libBuilding, panBuilding];
    const roadList: CityRoad[] = [
      { from: 'minsk_library', to: 'agent_pantheon', type: 'forum', lanes: 5, width: 14, name: 'Via Sacra' }
    ];

    const ringSize = 8;
    const ringCount = Math.ceil(rooms.length / ringSize);

    for (let ring = 0; ring < ringCount; ring++) {
      const ringRooms = rooms.slice(ring * ringSize, (ring + 1) * ringSize);
      const countInRing = ringRooms.length;
      const radius = 520 + ring * 260;
      const baseAngle = 25 + ring * 18;

      ringRooms.forEach((r, idx) => {
        const bId = `room_${r.room_id}`;
        const angleDeg = Math.round((baseAngle + (360 / countInRing) * idx) % 360);
        const angleRad = (angleDeg * Math.PI) / 180;
        const gridX = Math.round(radius * Math.cos(angleRad));
        const gridY = Math.round(radius * Math.sin(angleRad));

        const { archetype, cleanDescription } = parseRoomMetadata(r.description);
        const arch = r.description?.includes('[archetype:')
          ? archetype
          : ROOM_ARCHETYPES[(ring * ringSize + idx) % ROOM_ARCHETYPES.length];

        bList.push({
          id: bId,
          name: `#${r.title}`,
          badge: arch.badge,
          type: arch.category as BuildingType,
          shape: arch.id as BuildingShape,
          color: arch.color,
          gridX,
          gridY,
          width: 115,
          depth: 100,
          height: 140,
          messages: r.message_count || 1,
          topic: cleanDescription || arch.defaultTopic,
          associatedRoomId: r.room_id
        });

        const centerHub = gridX < 0 ? 'minsk_library' : 'agent_pantheon';
        roadList.push({
          from: centerHub,
          to: bId,
          type: 'radial',
          lanes: 4,
          width: 10,
          name: `Via ${arch.nameEn}`,
          angleDeg
        });
      });
    }

    const drones: CityAgentDrone[] = defaultDrones.map((d, i) => ({
      ...d,
      roadIdx: i % Math.max(1, roadList.length)
    }));

    return { buildings: bList, roads: roadList, agentFleet: drones };
  }, [rooms, cardCount, agentCount]);

  const [hoveredBuilding, setHoveredBuilding] = useState<CityBuilding | null>(null);
  const [lockedBuilding, setLockedBuilding] = useState<CityBuilding | null>(null);
  const [transitionState, setTransitionState] = useState<TransitionState>('idle');

  const [camera, setCamera] = useState<CityCamera>({
    focalX: 0,
    focalY: 0,
    targetFocalX: 0,
    targetFocalY: 0,
    zoom: 0.88,
    targetZoom: 0.88
  });

  // Плавный интерполятор камеры (Lerp)
  useEffect(() => {
    let animId: number;
    const updateCamera = () => {
      setCamera(prev => {
        const lerpFactor = transitionState === 'diving' ? 0.20 : 0.13;
        const nextFocalX = prev.focalX + (prev.targetFocalX - prev.focalX) * lerpFactor;
        const nextFocalY = prev.focalY + (prev.targetFocalY - prev.focalY) * lerpFactor;
        const nextZoom = prev.zoom + (prev.targetZoom - prev.zoom) * lerpFactor;
        return {
          ...prev,
          focalX: nextFocalX,
          focalY: nextFocalY,
          zoom: nextZoom
        };
      });
      animId = requestAnimationFrame(updateCamera);
    };
    animId = requestAnimationFrame(updateCamera);
    return () => cancelAnimationFrame(animId);
  }, [transitionState]);

  // Двухфазный влёт при клике на здание
  const handleSelectBuilding = useCallback((building: CityBuilding) => {
    if (transitionState !== 'idle') return;

    const bIsoX = (building.gridX - building.gridY) * 0.866025;
    const bIsoY = (building.gridX + building.gridY) * 0.5 - (building.height * 0.4);

    // Фаза 1: Фокусировка
    setTransitionState('focusing');
    setLockedBuilding(building);
    setCamera(prev => ({
      ...prev,
      targetFocalX: bIsoX,
      targetFocalY: bIsoY,
      targetZoom: 1.65
    }));

    // Фаза 2: Влёт внутрь
    setTimeout(() => {
      setTransitionState('diving');
      setCamera(prev => ({
        ...prev,
        targetFocalX: bIsoX,
        targetFocalY: bIsoY,
        targetZoom: 6.5
      }));

      // Переход на внутренний экран
      setTimeout(() => {
        setTransitionState('inside');
        setLockedBuilding(null);

        if (building.type === 'library') {
          onNavigate({ view: 'knowledge' });
        } else if (building.type === 'pantheon') {
          onNavigate({ view: 'agents' });
        } else if (building.associatedRoomId) {
          onNavigate({ view: 'rooms', roomId: building.associatedRoomId });
        } else {
          onNavigate({ view: 'rooms' });
        }
      }, 550);
    }, 650);
  }, [transitionState, onNavigate]);

  const handlePan = (dx: number, dy: number) => {
    setCamera(prev => ({
      ...prev,
      targetFocalX: prev.targetFocalX - dx / prev.zoom,
      targetFocalY: prev.targetFocalY - dy / prev.zoom,
      focalX: prev.focalX - dx / prev.zoom,
      focalY: prev.focalY - dy / prev.zoom
    }));
  };

  const handleZoom = (delta: number) => {
    setCamera(prev => {
      const nextZoom = Math.min(2.8, Math.max(0.35, prev.targetZoom + delta));
      return { ...prev, targetZoom: nextZoom };
    });
  };

  const handleCenter = () => {
    setCamera(prev => ({
      ...prev,
      targetFocalX: 0,
      targetFocalY: 0,
      targetZoom: 0.88
    }));
  };

  return (
    <div className="relative w-full h-[calc(100vh-80px)] min-h-[500px] overflow-hidden bg-[#070d19] rounded-2xl border border-cyan-500/20 shadow-2xl">
      <CityCanvas
        buildings={buildings}
        roads={roads}
        agentFleet={agentFleet}
        camera={camera}
        transitionState={transitionState}
        hoveredBuilding={hoveredBuilding}
        lockedBuilding={lockedBuilding}
        onHoverBuilding={setHoveredBuilding}
        onSelectBuilding={handleSelectBuilding}
        onPan={handlePan}
        onZoom={handleZoom}
      />
      <CityHUD
        buildings={buildings}
        camera={camera}
        lockedBuilding={lockedBuilding}
        onSelectBuilding={handleSelectBuilding}
        onPanBy={(dx, dy) => handlePan(-dx, -dy)}
        onCenter={handleCenter}
        onZoom={handleZoom}
        onExitToView={view => onNavigate({ view })}
      />
      <DiveOverlay state={transitionState} target={lockedBuilding} />
    </div>
  );
};
