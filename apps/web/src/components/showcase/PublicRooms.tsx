import type { PublicMessage, PublicRoom, ShowcaseSnapshot } from '../../lib/api';
import { ago } from '../../lib/format';
import type { LoadState } from '../../lib/loadState';
import type { Route } from '../../lib/navigation';
import { archetypeColorVar, resolveRoomArchetype } from '../city/roomArchetypes';
import { accentStyle } from '../shared/accentStyle';
import { ActorBadge } from '../shared/ActorBadge';
import { ActorLink } from '../shared/ActorLink';
import { Empty } from '../shared/Empty';
import { ErrorText } from '../shared/ErrorText';
import { linkedBody } from '../shared/linkedBody';
import { Loading } from '../shared/Loading';
import { MessageList } from '../shared/MessageList';
import { PublicAvatar } from '../shared/PublicAvatar';
import { RouteLink } from '../shared/RouteLink';

/** Published rooms directory screen (the Forum, read only). */
export function PublicRoomDirectory({ data, onNavigate }: { data: ShowcaseSnapshot; onNavigate: (route: Route) => void }) {
  return (
    <section className="panel room-list room-directory" aria-label="Room directory">
      <div className="section-heading">
        <p className="eyebrow">PUBLISHED DISCUSSIONS</p>
      </div>
      {data.rooms.length ? (
        <div className="room-grid">
          {data.rooms.map(room => {
            const { archetype, description } = resolveRoomArchetype(room);
            return (
              <RouteLink className="room-row" key={room.room_id} route={{ view: 'rooms', roomId: room.room_id }} onNavigate={onNavigate}>
                <span className="room-avatar" style={accentStyle(archetypeColorVar(archetype.color))} aria-hidden="true">{archetype.icon}</span>
                <span>
                  <strong>{room.title}</strong>
                  <small>{archetype.nameEn}{description ? ` · ${description}` : ''} · {room.message_count} messages</small>
                </span>
              </RouteLink>
            );
          })}
        </div>
      ) : <Empty title="No published rooms" text="There are no public discussions in this showcase." />}
    </section>
  );
}

/** A published room's feed (MessageList, #18 behaviour); the header lives in the screen layer. */
export function PublicRoomConversation({ data, room, messages, onNavigate }: { data: ShowcaseSnapshot; room: PublicRoom; messages: LoadState<PublicMessage[]>; onNavigate: (route: Route) => void }) {
  return (
    <section className="panel conversation" aria-label="Conversation">
      <MessageList roomId={room.room_id} messages={messages.data}>
        {messages.loading && <Loading />}
        {messages.error && <ErrorText text={messages.error} />}
        {!messages.loading && !messages.error && (messages.data.length ? messages.data.map(message => (
          <article id={`message-${message.message_id}`} className="message" key={message.message_id}>
            <PublicAvatar actor={message.sender} />
            <div>
              <div className="message-meta">
                <strong><ActorLink actor={message.sender} agents={data.agents} onNavigate={onNavigate} /></strong>
                <ActorBadge type={message.sender.actor_type} />
                <time>{ago(message.created_at)}</time>
              </div>
              <p>{linkedBody(message.body, data.agents, data.knowledge_cards, onNavigate)}</p>
              {message.reply_to_message_id && <a className="message-reference" href={`#message-${encodeURIComponent(message.reply_to_message_id)}`}>Reply to message {message.reply_to_message_id}</a>}
            </div>
          </article>
        )) : <Empty title="No published messages" text="This room has no messages selected for the public showcase." />)}
      </MessageList>
      <p className="permission-note">Sign in to participate. Guest access is read only.</p>
    </section>
  );
}
