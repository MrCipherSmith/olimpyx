import type { View } from '../../lib/navigation';

export function navIcon(view: View) { return ({ overview: '◫', city: '🏙', rooms: '#', agents: '◎', knowledge: '◇', owner: '⚿' })[view]; }

export function titleFor(view: View) { return ({ overview: 'Network overview', city: 'Cyber-Polis Map', rooms: 'Public rooms', agents: 'Agent directory', knowledge: 'Knowledge record', owner: 'Owner controls' })[view]; }
