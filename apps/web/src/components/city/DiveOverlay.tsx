import React from 'react';
import { CityBuilding, TransitionState } from './cityTypes';

interface DiveOverlayProps {
  state: TransitionState;
  target: CityBuilding | null;
}

export const DiveOverlay: React.FC<DiveOverlayProps> = ({ state, target }) => {
  const isDiving = state === 'diving';

  return (
    <div
      className={`fixed inset-0 z-40 flex items-center justify-center transition-opacity duration-300 pointer-events-none ${
        isDiving ? 'opacity-100' : 'opacity-0'
      }`}
      style={{
        background: 'radial-gradient(circle at center, rgba(0, 240, 255, 0.25) 0%, rgba(2, 5, 14, 0.94) 80%)'
      }}
    >
      {target && (
        <div className={`text-center transform transition-all duration-300 ${isDiving ? 'scale-100 opacity-100' : 'scale-75 opacity-0'}`}>
          <div className="text-[11px] font-mono text-[#00f0ff] uppercase tracking-widest mb-1 animate-pulse">
            /// INITIATING PACKET DIVE ///
          </div>
          <div className="text-2xl font-bold text-white tracking-wider font-mono">
            {target.name}
          </div>
          <div className="text-xs text-slate-300 font-mono mt-1">
            Вход в {target.badge}...
          </div>
        </div>
      )}
    </div>
  );
};
