import type { PublicMessage, PublicRoom, ShowcaseSnapshot } from '../../lib/api';
import { ago } from '../../lib/format';
import type { LoadState } from '../../lib/loadState';
import type { Route } from '../../lib/navigation';
import { parseRoomMetadata } from '../city/roomArchetypes';
import { accentStyle } from '../shared/accentStyle';
import { ActorBadge } from '../shared/ActorBadge';
import { ActorLink } from '../shared/ActorLink';
import { Empty } from '../shared/Empty';
import { ErrorText } from '../shared/ErrorText';
import { linkedBody } from '../shared/linkedBody';
import { Loading } from '../shared/Loading';
import { MessageList } from '../shared/MessageList';
import { PublicAvatar } from '../shared/PublicAvatar';
import { RoomDescription } from '../shared/RoomDescription';
import { RouteLink } from '../shared/RouteLink';

export function PublicRooms({ data, selected, messages, onNavigate }: { data: ShowcaseSnapshot; selected?: PublicRoom; messages: LoadState<PublicMessage[]>; onNavigate: (route: Route) => void }) {
  return (
    <div className="split-layout">
      <section className="panel room-list">
        <div className="section-heading">
          <div>
            <p className="eyebrow">PUBLISHED DISCUSSIONS</p>
            <h2>Rooms</h2>
          </div>
        </div>
        {data.rooms.length ? data.rooms.map(room => {
          const { archetype, cleanDescription } = parseRoomMetadata(room.description);
          return (
            <RouteLink className="room-row" current={selected?.room_id === room.room_id} key={room.room_id} route={{ view: 'rooms', roomId: room.room_id }} onNavigate={onNavigate}>
              <span className="room-avatar" style={accentStyle(archetype.color)} aria-hidden="true">{archetype.icon}</span>
              <span>
                <strong>{room.title}</strong>
                <small>{archetype.badge} · {cleanDescription || archetype.defaultTopic} · {room.message_count} messages</small>
              </span>
            </RouteLink>
          );
        }) : <Empty title="No published rooms" text="There are no public discussions in this showcase." />}
      </section>
      <section className="panel conversation">
        {selected ? (
          <>
            <div className="conversation-head">
              <div>
                <p className="eyebrow">PUBLISHED ROOM</p>
                <h2>{selected.title}</h2>
                <RoomDescription key={selected.room_id} description={selected.description} />
              </div>
              <span className="public-badge">Read only</span>
            </div>
            <MessageList roomId={selected.room_id} messages={messages.data}>
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
          </>
        ) : <Empty title="Choose a room" text="Select a published room to read its conversation." />}
      </section>
    </div>
  );
}
