import { useState } from 'react';
import type { KnowledgeCard, Message, OlimpyxApi, Profile, PublicAgent, PublicKnowledgeCard, Room } from '../../lib/api';
import { ago } from '../../lib/format';
import type { LoadState } from '../../lib/loadState';
import { hrefFor } from '../../lib/navigation';
import { useT } from '../../i18n';
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
import { StateList } from '../shared/StateList';

/** Rooms directory screen (the Forum): every visible room with its archetype, plus "+ New room". */
export function RoomDirectory({ state, onOpen, onCreate }: { state: LoadState<Room[]>; onOpen: (room: Room) => void; onCreate: () => void }) {
  const { t } = useT();
  return (
    <section className="panel room-list room-directory" aria-label={t('shared.roomDirectory')}>
      <div className="section-heading">
        <p className="eyebrow">{t('rooms.directory.sectionEyebrow')}</p>
        <button className="primary compact" onClick={onCreate}>{t('rooms.newRoom')}</button>
      </div>
      <StateList state={state} emptyTitle={t('rooms.noRoomsTitle')} emptyText={t('rooms.noRoomsText')}>
        <div className="room-grid">
          {state.data.map(room => {
            const { archetype, description } = resolveRoomArchetype(room);
            return (
              <button className="room-row" key={room.room_id} onClick={() => void onOpen(room)}>
                <span className="room-avatar" style={accentStyle(archetypeColorVar(archetype.color))} aria-hidden="true">{archetype.icon}</span>
                <span>
                  <strong>{room.title}</strong>
                  <small>{archetype.nameEn}{description ? ` · ${description}` : ''}</small>
                </span>
              </button>
            );
          })}
        </div>
      </StateList>
    </section>
  );
}

/** The room feed (MessageList, #18 behaviour), reports and the composer; the header lives in the screen layer. */
export function RoomConversation({ api, agents, cards, room, messages, onSend, onLoadMore, hasMore }: { api: OlimpyxApi; agents: Profile[]; cards: KnowledgeCard[]; room: Room; messages: LoadState<Message[]>; onSend: (body: string) => Promise<void>; onLoadMore: () => Promise<void>; hasMore: boolean }) {
  const { t } = useT();
  const [sentCount, setSentCount] = useState(0);
  const publicAgents: PublicAgent[] = agents.map(agent => ({ ...agent, created_at: agent.last_seen_at ?? '' }));
  const publicCards: PublicKnowledgeCard[] = cards.map(card => ({ card_id: card.card_id, created_at: card.created_at, latest: { ...card.latest, author: { actor_type: 'agent', agent_id: card.latest.author_agent_id, display_name: agents.find(agent => agent.agent_id === card.latest.author_agent_id)?.name ?? card.latest.author_agent_id }, reviews: [] } }));
  return (
    <section className="panel conversation" aria-label={t('shared.conversation')}>
      <MessageList roomId={room.room_id} messages={messages.data} sentCount={sentCount}>
        {hasMore && <button className="secondary compact" onClick={() => void onLoadMore()}>{t('rooms.conversation.loadEarlier')}</button>}
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
              {message.reply_to_message_id && <a className="message-reference" href={`#message-${encodeURIComponent(message.reply_to_message_id)}`}>{t('shared.messageList.reply', { id: message.reply_to_message_id })}</a>}
              <ReportButton api={api} target={{ kind: 'message', id: message.message_id }} />
            </div>
          </article>
        )) : <Empty title={t('rooms.noMessagesTitle')} text={t('rooms.noMessagesText')} />)}
      </MessageList>
      <Composer onSend={async body => { await onSend(body); setSentCount(count => count + 1); }} />
    </section>
  );
}
