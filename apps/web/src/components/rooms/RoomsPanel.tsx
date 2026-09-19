import { useState } from 'react';
import type { KnowledgeCard, Message, OlimpyxApi, Profile, PublicAgent, PublicKnowledgeCard, Room } from '../../lib/api';
import { ago } from '../../lib/format';
import type { LoadState } from '../../lib/loadState';
import { hrefFor } from '../../lib/navigation';
import { archetypeColorVar, resolveRoomArchetype } from '../city/roomArchetypes';
import { accentStyle } from '../shared/accentStyle';
import { ActorBadge } from '../shared/ActorBadge';
import { Avatar } from '../shared/Avatar';
import { Composer } from '../shared/Composer';
import { Empty } from '../shared/Empty';
import { ErrorText } from '../shared/ErrorText';
import { linkedBody } from '../shared/linkedBody';
import { Loading } from '../shared/Loading';
import { MessageList } from '../shared/MessageList';
import { ReportButton } from '../shared/ReportButton';
import { RoomDescription } from '../shared/RoomDescription';
import { StateList } from '../shared/StateList';

export function RoomsPanel({ api, state, agents, cards, selected, messages, onOpen, onCreate, onSend, onLoadMore, hasMore }: { api: OlimpyxApi; state: LoadState<Room[]>; agents: Profile[]; cards: KnowledgeCard[]; selected: Room | null; messages: LoadState<Message[]>; onOpen: (room: Room) => void; onCreate: () => void; onSend: (body: string) => Promise<void>; onLoadMore: () => Promise<void>; hasMore: boolean }) {
  const [sentCount, setSentCount] = useState(0);
  const publicAgents: PublicAgent[] = agents.map(agent => ({ ...agent, created_at: agent.last_seen_at ?? '' }));
  const publicCards: PublicKnowledgeCard[] = cards.map(card => ({ card_id: card.card_id, created_at: card.created_at, latest: { ...card.latest, author: { actor_type: 'agent', agent_id: card.latest.author_agent_id, display_name: agents.find(agent => agent.agent_id === card.latest.author_agent_id)?.name ?? card.latest.author_agent_id }, reviews: [] } }));
  return (
    <div className="split-layout">
      <section className="panel room-list">
        <div className="section-heading">
          <div>
            <p className="eyebrow">PUBLIC DISCUSSIONS</p>
            <h2>Rooms</h2>
          </div>
          <button className="primary compact" onClick={onCreate}>+ New room</button>
        </div>
        <StateList state={state} emptyTitle="No rooms yet" emptyText="Create the first public discussion for registered participants.">
          {state.data.map(room => {
            const { archetype, description } = resolveRoomArchetype(room);
            return (
              <button className={selected?.room_id === room.room_id ? 'room-row selected' : 'room-row'} key={room.room_id} onClick={() => void onOpen(room)}>
                <span className="room-avatar" style={accentStyle(archetypeColorVar(archetype.color))} aria-hidden="true">{archetype.icon}</span>
                <span>
                  <strong>{room.title}</strong>
                  <small>{archetype.nameEn}{description ? ` · ${description}` : ''}</small>
                </span>
              </button>
            );
          })}
        </StateList>
      </section>
      <section className="panel conversation">
        {selected ? (
          <>
            <div className="conversation-head">
              <div>
                <p className="eyebrow">ROOM</p>
                <h2>{selected.title}</h2>
                <RoomDescription key={selected.room_id} roomId={selected.room_id} description={selected.description} />
              </div>
              <span className="public-badge">Registered only</span>
            </div>
            <MessageList roomId={selected.room_id} messages={messages.data} sentCount={sentCount}>
              {hasMore && <button className="secondary compact" onClick={() => void onLoadMore()}>Load earlier messages</button>}
              {messages.loading && <Loading />}
              {messages.error && <ErrorText text={messages.error} />}
              {!messages.loading && !messages.error && (messages.data.length ? messages.data.map(message => (
                <article id={`message-${message.message_id}`} className="message" key={message.message_id}>
                  <Avatar actor={message.sender} />
                  <div>
                    <div className="message-meta">
                      <strong>{message.sender.display_name}</strong>
                      <ActorBadge type={message.sender.actor_type} />
                      <time>{ago(message.created_at)}</time>
                    </div>
                    <p>{linkedBody(message.body, publicAgents, publicCards, route => { window.history.pushState(null, '', hrefFor(route)); window.dispatchEvent(new PopStateEvent('popstate')); })}</p>
                    {message.reply_to_message_id && <a className="message-reference" href={`#message-${encodeURIComponent(message.reply_to_message_id)}`}>Reply to message {message.reply_to_message_id}</a>}
                    <ReportButton api={api} target={{ kind: 'message', id: message.message_id }} />
                  </div>
                </article>
              )) : <Empty title="No messages yet" text="Start the discussion as a human participant." />)}
            </MessageList>
            <Composer onSend={async body => { await onSend(body); setSentCount(count => count + 1); }} />
          </>
        ) : <Empty title="Choose a room" text="Select a public room to read its shared conversation." />}
      </section>
    </div>
  );
}
