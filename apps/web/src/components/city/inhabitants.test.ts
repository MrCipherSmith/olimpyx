import { describe, expect, it } from 'vitest';
import { buildCityScene } from './cityScene';
import {
  DEFAULT_INHABITANT_CAP, INHABITANT_TRANSITION_MS, hashUnit, inhabitantActivityFromMessages, inhabitantActivityFromShowcase,
  inhabitantPosition, planInhabitants, type InhabitantAgentInput, type InhabitantOnlineFigure,
} from './inhabitants';

const rooms = (count: number) => Array.from({ length: count }, (_, index) => ({ room_id: `rom_${index}`, title: `Room ${index}` }));
const agent = (agent_id: string, name: string, presence: 'online' | 'offline' = 'online'): InhabitantAgentInput => ({ agent_id, name, presence });

describe('planInhabitants', () => {
  it('draws real agents only: no id or blank name is dropped', () => {
    const scene = buildCityScene(rooms(1));
    const plan = planInhabitants([
      agent('a1', 'Athena'),
      { agent_id: '', name: 'Ghost', presence: 'online' },
      { agent_id: 'a2', name: '   ', presence: 'online' },
    ], [], scene, 0);
    expect(plan.figures.map(figure => figure.name)).toEqual(['Athena']);
    expect(plan.figures.every(figure => figure.name.length > 0)).toBe(true);
  });

  it('never invents a room link: an online agent with no real activity wanders Pantheon <-> forum', () => {
    const scene = buildCityScene(rooms(2));
    const plan = planInhabitants([agent('solo', 'Solo')], [], scene, 0);
    const figure = plan.figures[0] as InhabitantOnlineFigure;
    expect(figure.online).toBe(true);
    expect(figure.to).toEqual({ x: 0, y: 0 }); // forum centre
  });

  it('links an online agent to a room it is really connected to, from the activity input', () => {
    const scene = buildCityScene(rooms(2));
    const room0 = scene.roomBuildings.find(building => building.room?.roomId === 'rom_0')!;
    const plan = planInhabitants([agent('a1', 'Athena')], [{ agentId: 'a1', roomId: 'rom_0' }], scene, 0);
    const figure = plan.figures[0] as InhabitantOnlineFigure;
    expect(figure.to).toEqual({ x: room0.x, y: room0.y });
    const pantheon = scene.buildings.find(building => building.kind === 'pantheon')!;
    expect(figure.from).toEqual({ x: pantheon.x, y: pantheon.y });
  });

  it('the most recently listed activity entry wins when an agent has more than one', () => {
    const scene = buildCityScene(rooms(2));
    const room1 = scene.roomBuildings.find(building => building.room?.roomId === 'rom_1')!;
    const plan = planInhabitants([agent('a1', 'Athena')], [{ agentId: 'a1', roomId: 'rom_0' }, { agentId: 'a1', roomId: 'rom_1' }], scene, 0);
    const figure = plan.figures[0] as InhabitantOnlineFigure;
    expect(figure.to).toEqual({ x: room1.x, y: room1.y });
  });

  it('stands offline agents dimmed and static near the Pantheon, fanned out instead of stacked', () => {
    const scene = buildCityScene(rooms(1));
    const pantheon = scene.buildings.find(building => building.kind === 'pantheon')!;
    const plan = planInhabitants([agent('a1', 'Athena', 'offline'), agent('a2', 'Boreas', 'offline')], [], scene, 0);
    expect(plan.figures.every(figure => figure.online === false)).toBe(true);
    for (const figure of plan.figures) {
      if (figure.online) continue;
      const distance = Math.hypot(figure.x - pantheon.x, figure.y - pantheon.y);
      expect(distance).toBeGreaterThan(0);
      expect(distance).toBeLessThan(150);
    }
    const [a, b] = plan.figures;
    if (!a.online && !b.online) expect(a.x === b.x && a.y === b.y).toBe(false); // fanned out, not stacked
  });

  it('caps the figures and reports the rest as overflow, keeping the split deterministic by agent id', () => {
    const scene = buildCityScene(rooms(1));
    const agents = Array.from({ length: 50 }, (_, index) => agent(`a${String(index).padStart(2, '0')}`, `Agent ${index}`));
    const plan = planInhabitants(agents, [], scene, 0, 40);
    expect(plan.figures).toHaveLength(40);
    expect(plan.overflow).toBe(10);
    expect(plan.total).toBe(50);
    expect(plan.figures.map(figure => figure.id)).toEqual(agents.slice(0, 40).map(a => a.agent_id));
  });

  it('defaults the cap to 40', () => {
    const scene = buildCityScene(rooms(1));
    const agents = Array.from({ length: 45 }, (_, index) => agent(`a${index}`, `Agent ${index}`));
    const plan = planInhabitants(agents, [], scene, 0);
    expect(plan.figures.length).toBeLessThanOrEqual(DEFAULT_INHABITANT_CAP);
    expect(plan.overflow).toBe(45 - plan.figures.length);
  });

  it('never shows a "+N" (zero overflow) when every agent fits', () => {
    const scene = buildCityScene(rooms(1));
    const plan = planInhabitants([agent('a1', 'Athena')], [], scene, 0);
    expect(plan.overflow).toBe(0);
  });

  it('is deterministic: the same inputs always produce the same figures', () => {
    const scene = buildCityScene(rooms(3));
    const agents = [agent('a1', 'Athena'), agent('a2', 'Boreas', 'offline'), agent('a3', 'Circe')];
    const activity = [{ agentId: 'a1', roomId: 'rom_0' }, { agentId: 'a3', roomId: 'rom_2' }];
    const first = planInhabitants(agents, activity, scene, 12345);
    const second = planInhabitants(agents, activity, scene, 12345);
    expect(second).toEqual(first);
  });

  it('gives a stable path/position for a given agent id regardless of the rest of the roster', () => {
    const scene = buildCityScene(rooms(1));
    const alone = planInhabitants([agent('a1', 'Athena')], [], scene, 500).figures[0] as InhabitantOnlineFigure;
    const withOthers = planInhabitants([agent('z9', 'Zeus'), agent('a1', 'Athena')], [], scene, 500).figures.find(f => f.id === 'a1') as InhabitantOnlineFigure;
    expect(withOthers).toEqual(alone);
  });
});

describe('planInhabitants replans (continuity)', () => {
  const scene = buildCityScene(rooms(3));
  const agents = [agent('a1', 'Athena'), agent('a2', 'Boreas', 'offline'), agent('a3', 'Circe')];
  const activity = [{ agentId: 'a1', roomId: 'rom_0' }, { agentId: 'a3', roomId: 'rom_2' }];
  const byId = (plan: ReturnType<typeof planInhabitants>, id: string) => plan.figures.find(figure => figure.id === id)!;
  const close = (a: { x: number; y: number }, b: { x: number; y: number }) => { expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6); };

  it('keeps every figure exactly where it is when the same activity is re-fetched (a fresh array)', () => {
    const first = planInhabitants(agents, activity, scene, 1000);
    const replanAt = 1000 + 5000; // the showcase poll
    const second = planInhabitants(agents, activity.map(link => ({ ...link })), scene, replanAt, DEFAULT_INHABITANT_CAP, first);
    for (const figure of first.figures) {
      const again = byId(second, figure.id);
      if (figure.online && again.online) expect(again.phaseAnchor).toBe(figure.phaseAnchor);
      expect(again.transition).toBeUndefined();
      for (const at of [replanAt, replanAt + 1, replanAt + 7777]) close(inhabitantPosition(again, at), inhabitantPosition(figure, at));
    }
  });

  it('glides a figure whose linked room changed from where it was onto its new path, keeping its anchor', () => {
    const first = planInhabitants(agents, activity, scene, 1000);
    const replanAt = 6000;
    const moved = [{ agentId: 'a1', roomId: 'rom_1' }, { agentId: 'a3', roomId: 'rom_2' }];
    const second = planInhabitants(agents, moved, scene, replanAt, DEFAULT_INHABITANT_CAP, first);
    const before = byId(first, 'a1') as InhabitantOnlineFigure;
    const after = byId(second, 'a1') as InhabitantOnlineFigure;
    const room1 = scene.roomBuildings.find(building => building.room?.roomId === 'rom_1')!;
    expect(after.to).toEqual({ x: room1.x, y: room1.y });
    expect(after.phaseAnchor).toBe(before.phaseAnchor);
    // Continuous at the replan instant, and never a jump of more than a small step one frame later.
    close(inhabitantPosition(after, replanAt), inhabitantPosition(before, replanAt));
    const next = inhabitantPosition(after, replanAt + 16);
    const now = inhabitantPosition(after, replanAt);
    expect(Math.hypot(next.x - now.x, next.y - now.y)).toBeLessThan(10);
    // Once the glide is over the figure walks its new path exactly.
    const settled = { ...after, transition: undefined };
    close(inhabitantPosition(after, replanAt + INHABITANT_TRANSITION_MS + 1), inhabitantPosition(settled, replanAt + INHABITANT_TRANSITION_MS + 1));
    // Untouched figures are not re-pathed.
    expect(byId(second, 'a3').transition).toBeUndefined();
  });

  it('carries a glide still under way through another replan instead of restarting it', () => {
    const first = planInhabitants(agents, activity, scene, 1000);
    const moved = [{ agentId: 'a1', roomId: 'rom_1' }];
    const second = planInhabitants(agents, moved, scene, 6000, DEFAULT_INHABITANT_CAP, first);
    const third = planInhabitants(agents, moved.map(link => ({ ...link })), scene, 6300, DEFAULT_INHABITANT_CAP, second);
    expect(byId(third, 'a1').transition).toEqual(byId(second, 'a1').transition);
    close(inhabitantPosition(byId(third, 'a1'), 6500), inhabitantPosition(byId(second, 'a1'), 6500));
  });

  it('glides between the walk and the resting spot when presence changes', () => {
    const first = planInhabitants(agents, activity, scene, 1000);
    const offline = agents.map(entry => (entry.agent_id === 'a1' ? { ...entry, presence: 'offline' as const } : entry));
    const second = planInhabitants(offline, activity, scene, 6000, DEFAULT_INHABITANT_CAP, first);
    const figure = byId(second, 'a1');
    expect(figure.online).toBe(false);
    close(inhabitantPosition(figure, 6000), inhabitantPosition(byId(first, 'a1'), 6000));
    const rest = figure.online ? null : { x: figure.x, y: figure.y };
    close(inhabitantPosition(figure, 6000 + INHABITANT_TRANSITION_MS), rest!);
  });

  it('moves at once with reduced motion (transitionMs = 0) while keeping the anchor', () => {
    const first = planInhabitants(agents, activity, scene, 1000);
    const second = planInhabitants(agents, [{ agentId: 'a1', roomId: 'rom_1' }], scene, 6000, DEFAULT_INHABITANT_CAP, first, 0);
    const after = byId(second, 'a1') as InhabitantOnlineFigure;
    expect(after.transition).toBeUndefined();
    expect(after.phaseAnchor).toBe((byId(first, 'a1') as InhabitantOnlineFigure).phaseAnchor);
  });

  it('starts a newly shown agent at its deterministic phase and ignores agents that left', () => {
    const first = planInhabitants([agent('a1', 'Athena')], [], scene, 1000);
    const second = planInhabitants([agent('a3', 'Circe')], [], scene, 6000, DEFAULT_INHABITANT_CAP, first);
    expect(second.figures.map(figure => figure.id)).toEqual(['a3']);
    expect(second.figures[0]).toEqual(planInhabitants([agent('a3', 'Circe')], [], scene, 6000).figures[0]);
  });
});

describe('hashUnit', () => {
  it('is deterministic and lands in [0, 1)', () => {
    expect(hashUnit('agent-1')).toBe(hashUnit('agent-1'));
    for (const id of ['a', 'agent-42', 'a-very-long-agent-identifier-string']) {
      const value = hashUnit(id);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('spreads different ids apart (not a constant function)', () => {
    const values = new Set(['a1', 'a2', 'a3', 'a4', 'a5'].map(hashUnit));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe('inhabitantPosition', () => {
  const scene = buildCityScene(rooms(1));

  it('is static for an offline figure regardless of the clock', () => {
    const figure = planInhabitants([agent('a1', 'Athena', 'offline')], [], scene, 0).figures[0];
    const p1 = inhabitantPosition(figure, 0);
    const p2 = inhabitantPosition(figure, 999_999);
    expect(p2).toEqual(p1);
  });

  it('reaches both ends of the path and never overshoots them (a triangle wave)', () => {
    const figure = planInhabitants([agent('a1', 'Athena')], [], scene, 0).figures[0] as InhabitantOnlineFigure;
    const samples = Array.from({ length: 400 }, (_, index) => inhabitantPosition(figure, index * 137));
    const xs = samples.map(p => p.x);
    const minX = Math.min(figure.from.x, figure.to.x);
    const maxX = Math.max(figure.from.x, figure.to.x);
    for (const x of xs) { expect(x).toBeGreaterThanOrEqual(minX - 1e-6); expect(x).toBeLessThanOrEqual(maxX + 1e-6); }
  });

  it('writes into a caller-owned scratch point instead of allocating one', () => {
    const figure = planInhabitants([agent('a1', 'Athena')], [], scene, 0).figures[0];
    const out = { x: 0, y: 0 };
    expect(inhabitantPosition(figure, 1234, out)).toBe(out);
    expect(out).toEqual(inhabitantPosition(figure, 1234));
  });

  it('freezing the clock (reduced motion) freezes the figure in place', () => {
    const figure = planInhabitants([agent('a1', 'Athena')], [], scene, 0).figures[0];
    const frozen = 4000;
    expect(inhabitantPosition(figure, frozen)).toEqual(inhabitantPosition(figure, frozen));
  });
});

describe('real-data adapters', () => {
  it('inhabitantActivityFromShowcase keeps only message activity with a room and a known agent', () => {
    const activity = inhabitantActivityFromShowcase([
      { kind: 'message', actor: { agent_id: 'a1' }, resource: { kind: 'room', id: 'rom_0' } },
      { kind: 'message', actor: { agent_id: null }, resource: { kind: 'room', id: 'rom_0' } }, // owner message, no agent
      { kind: 'knowledge', actor: { agent_id: 'a1' }, resource: { kind: 'knowledge_card', id: 'card_1' } },
    ]);
    expect(activity).toEqual([{ agentId: 'a1', roomId: 'rom_0' }]);
  });

  it('inhabitantActivityFromMessages links every agent sender to the given room, skipping owner messages', () => {
    const activity = inhabitantActivityFromMessages([
      { sender: { actor_type: 'agent', actor_id: 'a1' } },
      { sender: { actor_type: 'owner', actor_id: 'owner_1' } },
      { sender: { actor_type: 'agent', actor_id: 'a2' } },
    ], 'rom_9');
    expect(activity).toEqual([{ agentId: 'a1', roomId: 'rom_9' }, { agentId: 'a2', roomId: 'rom_9' }]);
  });
});
