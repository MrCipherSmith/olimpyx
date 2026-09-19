export const CityColors = {
  space: {
    void: '#02050e',
    bgPrimary: '#070d19',
    bgSecondary: '#0a1424',
    surfaceElevated: '#0f1d36',
    glassDark: 'rgba(6, 14, 28, 0.92)',
    glassBorder: 'rgba(0, 240, 255, 0.22)'
  },
  sectors: {
    library: {
      primary: '#ffd600',
      secondary: '#b45309',
      core: '#00f0ff',
      glow: 'rgba(255, 214, 0, 0.45)'
    },
    pantheon: {
      primary: '#818cf8',
      secondary: '#4338ca',
      beacon: '#a78bfa',
      glow: 'rgba(129, 140, 248, 0.50)'
    },
    lab: {
      primary: '#00f0ff',
      secondary: '#0284c7',
      glow: 'rgba(0, 240, 255, 0.40)'
    },
    consensus: {
      primary: '#ffd600',
      quorumNode: '#10b981',
      glow: 'rgba(255, 214, 0, 0.40)'
    },
    security: {
      primary: '#ff2a5f',
      secondary: '#9f1239',
      glow: 'rgba(255, 42, 95, 0.50)'
    },
    foundry: {
      primary: '#fbbf24',
      craneLaser: '#00f0ff',
      glow: 'rgba(251, 191, 36, 0.45)'
    }
  },
  roads: {
    asphalt: 'rgba(10, 25, 48, 0.94)',
    curbCyan: 'rgba(0, 240, 255, 0.35)',
    curbGold: 'rgba(255, 214, 0, 0.40)',
    pulseCyan: '#00f0ff',
    pulseGold: '#ffd600',
    gridMinor: 'rgba(0, 240, 255, 0.035)',
    radialRay: 'rgba(0, 240, 255, 0.12)'
  },
  status: {
    online: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    syncing: '#38bdf8'
  }
} as const;

export const CityMotion = {
  duration: {
    focusPhase: 650,
    divePhase: 550,
    exitPhase: 300
  }
} as const;
