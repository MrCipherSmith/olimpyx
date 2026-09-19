import type { ReactNode } from 'react';
import type { PublicAgent, PublicKnowledgeCard } from '../../lib/api';
import type { Route } from '../../lib/navigation';
import { RouteLink } from './RouteLink';

/** Turns agent and knowledge-card ids mentioned in a message body into readable in-app links. */
export function linkedBody(body: string, agents: PublicAgent[], cards: PublicKnowledgeCard[], onNavigate: (route: Route) => void): ReactNode { const entities = new Map<string, { label: string; route: Route }>(); agents.forEach(agent => entities.set(agent.agent_id, { label: agent.name, route: { view: 'agents', agentId: agent.agent_id } })); cards.forEach(card => entities.set(card.card_id, { label: card.latest.topic, route: { view: 'knowledge', cardId: card.card_id } })); if (!entities.size) return body; const escaped = [...entities.keys()].sort((a, b) => b.length - a.length).map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); const parts = body.split(new RegExp(`(${escaped.join('|')})`, 'g')); return parts.map((part, index) => { const entity = entities.get(part); return entity ? <RouteLink key={`${part}-${index}`} className="message-reference" route={entity.route} onNavigate={onNavigate}>{entity.label}</RouteLink> : part; }); }
