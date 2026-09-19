import React from 'react';
import { CityBuilding, CityCamera } from './cityTypes';
import { isoProject } from './isometricMath';

interface CityHUDProps {
  buildings: CityBuilding[];
  camera: CityCamera;
  lockedBuilding: CityBuilding | null;
  onSelectBuilding: (b: CityBuilding) => void;
  onPanBy: (dx: number, dy: number) => void;
  onCenter: () => void;
  onZoom: (delta: number) => void;
  onExitToView: (view: 'overview' | 'rooms' | 'agents' | 'knowledge') => void;
}

export const CityHUD: React.FC<CityHUDProps> = ({
  buildings,
  camera,
  lockedBuilding,
  onSelectBuilding,
  onPanBy,
  onCenter,
  onZoom,
  onExitToView
}) => {
  const lib = buildings.find(b => b.type === 'library');
  const pan = buildings.find(b => b.type === 'pantheon');
  const roomList = buildings.filter(b => b.type !== 'library' && b.type !== 'pantheon');


  let lockPos = { x: -999, y: -999 };
  if (lockedBuilding && typeof window !== 'undefined') {
    lockPos = isoProject(
      lockedBuilding.gridX,
      lockedBuilding.gridY,
      lockedBuilding.height * 0.5,
      camera,
      window.innerWidth,
      window.innerHeight
    );
  }

  return (
    <>
      {/* 1. Парящее компактное меню навигации слева сверху */}
      <div className="absolute top-5 left-5 z-20 flex flex-col gap-2 pointer-events-auto">
        <div className="flex items-center gap-2 p-2 rounded-xl border border-cyan-500/30 bg-[#060e1c]/90 backdrop-blur shadow-[0_0_20px_rgba(0,240,255,0.15)] text-slate-200">
          <div className="flex items-center gap-1.5 px-2 border-r border-cyan-500/30 font-mono font-bold text-xs text-[#00f0ff]">
            <span className="text-sm">◈</span> OLIMPYX POLIS
          </div>
          <button
            onClick={() => onExitToView('overview')}
            className="px-2.5 py-1 rounded-md text-xs font-mono font-medium hover:bg-cyan-500/20 hover:text-white transition"
          >
            Dashboard
          </button>
          <button
            onClick={() => lib && onSelectBuilding(lib)}
            className="px-2.5 py-1 rounded-md text-xs font-mono font-medium text-amber-300 hover:bg-amber-400/20 hover:text-white transition"
          >
            ◈ Knowledge Vault
          </button>
          <button
            onClick={() => pan && onSelectBuilding(pan)}
            className="px-2.5 py-1 rounded-md text-xs font-mono font-medium text-indigo-300 hover:bg-indigo-500/20 hover:text-white transition"
          >
            ⦾ Pantheon
          </button>
          <button
            onClick={() => {
              if (roomList[0]) onSelectBuilding(roomList[0]);
              else onExitToView('rooms');
            }}
            className="px-2.5 py-1 rounded-md text-xs font-mono font-medium text-cyan-300 hover:bg-cyan-500/20 hover:text-white transition"
          >
            # Rooms ({roomList.length})
          </button>
        </div>
      </div>

      {/* 2. D-Pad скролла и зума справа сверху */}
      <div className="absolute top-5 right-5 z-20 flex flex-col gap-2 items-center pointer-events-auto">
        <div className="p-2 rounded-xl border border-cyan-500/30 bg-[#060e1c]/90 backdrop-blur shadow-lg flex flex-col items-center gap-1 text-cyan-400">
          <button
            onClick={() => onPanBy(0, -60)}
            className="w-8 h-8 rounded-lg hover:bg-cyan-500/20 flex items-center justify-center font-bold text-sm"
            title="Вверх"
          >
            ▲
          </button>
          <div className="flex gap-1">
            <button
              onClick={() => onPanBy(-60, 0)}
              className="w-8 h-8 rounded-lg hover:bg-cyan-500/20 flex items-center justify-center font-bold text-sm"
              title="Влево"
            >
              ◄
            </button>
            <button
              onClick={onCenter}
              className="w-8 h-8 rounded-lg hover:bg-amber-400/20 text-amber-300 flex items-center justify-center font-bold text-xs"
              title="Центрировать Форум"
            >
              ⊙
            </button>
            <button
              onClick={() => onPanBy(60, 0)}
              className="w-8 h-8 rounded-lg hover:bg-cyan-500/20 flex items-center justify-center font-bold text-sm"
              title="Вправо"
            >
              ►
            </button>
          </div>
          <button
            onClick={() => onPanBy(0, 60)}
            className="w-8 h-8 rounded-lg hover:bg-cyan-500/20 flex items-center justify-center font-bold text-sm"
            title="Вниз"
          >
            ▼
          </button>
          <div className="w-full h-px bg-cyan-500/20 my-1" />
          <div className="flex gap-1 w-full justify-center">
            <button
              onClick={() => onZoom(0.12)}
              className="flex-1 py-0.5 rounded hover:bg-cyan-500/20 text-xs font-mono font-bold"
              title="Приблизить"
            >
              +
            </button>
            <button
              onClick={() => onZoom(-0.12)}
              className="flex-1 py-0.5 rounded hover:bg-cyan-500/20 text-xs font-mono font-bold"
              title="Отдалить"
            >
              −
            </button>
          </div>
        </div>
      </div>

      {/* 3. Интерактивная легенда секторов снизу слева */}
      <div className="absolute bottom-6 left-5 z-20 pointer-events-auto p-2.5 rounded-xl border border-cyan-500/30 bg-[#060e1c]/90 backdrop-blur flex items-center gap-4 text-[10px] font-mono shadow-lg">
        {lib && (
          <button
            onClick={() => onSelectBuilding(lib)}
            className="flex items-center gap-1.5 hover:text-white transition text-amber-300"
          >
            <span className="text-sm">◈</span>
            <span className="font-bold">Библиотека</span>
          </button>
        )}
        {pan && (
          <button
            onClick={() => onSelectBuilding(pan)}
            className="flex items-center gap-1.5 hover:text-white transition text-indigo-300"
          >
            <span className="text-sm">⦾</span>
            <span className="font-bold">Пантеон</span>
          </button>
        )}
        {roomList.slice(0, 6).map(b => (
          <button
            key={b.id}
            onClick={() => onSelectBuilding(b)}
            className="flex items-center gap-1 hover:text-white transition"
            style={{ color: b.color }}
            title={b.topic}
          >
            <span className="font-bold">#</span>
            <span className="truncate max-w-[110px]">{b.name.replace('#', '')}</span>
          </button>
        ))}
      </div>


      {/* 4. Голографический прицел захвата цели */}
      {lockedBuilding && (
        <div
          className="pointer-events-none absolute z-30 transform -translate-x-1/2 -translate-y-1/2 flex flex-col items-center transition-all duration-300"
          style={{ left: `${lockPos.x}px`, top: `${lockPos.y}px` }}
        >
          <div className="w-16 h-16 border-2 border-cyan-400/80 rounded-full animate-ping opacity-60" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-20 h-20 border border-dashed border-cyan-300/80 rounded-full animate-spin" />
          <span className="mt-2 text-[10px] font-mono font-bold tracking-widest text-cyan-300 bg-slate-950/80 px-2 py-0.5 rounded border border-cyan-500/40 uppercase">
            TARGET LOCKED: {lockedBuilding.name.replace(/[◈⦾#]/g, '').trim()}
          </span>
        </div>
      )}
    </>
  );
};
