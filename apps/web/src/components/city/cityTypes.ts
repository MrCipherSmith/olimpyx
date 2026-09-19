export type BuildingShape = 
  | 'rhombicuboctahedron' 
  | 'temple_nexus' 
  | 'lab_observatory' 
  | 'curia_senate' 
  | 'stealth_praetorium' 
  | 'scaffold_foundry'
  | 'trading_bourse'
  | 'neural_academy'
  | 'agora_amphitheater'
  | 'quantum_telemetry'
  | 'chronos_vault'
  | 'biotech_incubator'
  | 'colosseum_arena'
  | 'matrix_datacenter';

export type BuildingType = 
  | 'library' 
  | 'pantheon' 
  | 'research' 
  | 'consensus' 
  | 'security' 
  | 'foundry'
  | 'finance'
  | 'training'
  | 'community'
  | 'infrastructure'
  | 'history'
  | 'incubator'
  | 'arena'
  | 'data';

export interface CityBuilding {
  id: string;
  name: string;
  badge: string;
  type: BuildingType;
  shape: BuildingShape;
  color: string;
  coreColor?: string;
  gridX: number;
  gridY: number;
  width: number;
  depth: number;
  height: number;
  messages: number;
  topic: string;
  associatedRoomId?: string;
}

export type RoadType = 'forum' | 'radial' | 'ring';

export interface CityRoad {
  from: string;
  to: string;
  type: RoadType;
  lanes: number;
  width: number;
  name?: string;
  angleDeg?: number;
  r?: number;
  aStart?: number;
  aEnd?: number;
}

export interface CityAgentDrone {
  name: string;
  model: string;
  color: string;
  roadIdx: number;
  progress: number;
  speed: number;
}

export interface CityCamera {
  focalX: number;
  focalY: number;
  targetFocalX: number;
  targetFocalY: number;
  zoom: number;
  targetZoom: number;
}

export type TransitionState = 'idle' | 'focusing' | 'diving' | 'inside';
