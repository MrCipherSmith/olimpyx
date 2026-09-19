import { type Dispatch, Fragment, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentsPanel } from './components/agents/AgentsPanel';
import { AuthScreen } from './components/auth/AuthScreen';
import type { CityCameraController } from './components/city/CityCanvas';
import { CityView } from './components/city/CityView';
import { buildCityScene } from './components/city/cityScene';
import { KnowledgePanel } from './components/knowledge/KnowledgePanel';
import { OwnerPanel } from './components/owner/OwnerPanel';
import { CreateRoom } from './components/rooms/CreateRoom';
import { RoomConversation, RoomDirectory } from './components/rooms/RoomsPanel';
import { Empty } from './components/shared/Empty';
import { ErrorText } from './components/shared/ErrorText';
import { Loading } from './components/shared/Loading';
import { RouteLink } from './components/shared/RouteLink';
import { agentsBadge, CityHud, countBadge, loadedCount } from './components/shell/CityHud';
import { CityShell } from './components/shell/CityShell';
import { DiveOverlay } from './components/shell/DiveOverlay';
import { RoomBadges, RoomSubline } from './components/shell/RoomHeader';
import { ScreenLayer } from './components/shell/ScreenLayer';
import { useCityRoute } from './components/shell/useCityRoute';
import { PublicShowcase } from './components/showcase/PublicShowcase';
import { OlimpyxApi, type KnowledgeCard, type Message, type Profile, type Room } from './lib/api';
import { ApiError, AuthSession, type StoredSession } from './lib/auth-session';
import { messageFrom } from './lib/format';
import { empty, type LoadState } from './lib/loadState';
import { screenFor } from './lib/navigation';
import { initialNetworkStatus, nextNetworkStatus, nextPollNetworkStatus } from './lib/networkStatus';

/** Root: owns the session, the route and the participant's private data; guests get the public showcase. */
export function App() {
  const sessionStore = useMemo(() => new AuthSession(), []);
  const api = useMemo(() => new OlimpyxApi(sessionStore), [sessionStore]);
  const [session, setSession] = useState<StoredSession | null>(() => sessionStore.current);
  const [rooms, setRooms] = useState(empty<Room[]>([]));
  // The participant's city (with the owner-only Praetorium): drawn by CityView and the dive targets.
  const scene = useMemo(() => buildCityScene(rooms.data, { includePraetorium: true }), [rooms.data]);
  const camera = useRef<CityCameraController | null>(null);
  const { route, navigate, close: closeScreen, reset: resetRoute, dive } = useCityRoute({ buildings: scene.buildings, camera });
  const [agents, setAgents] = useState(empty<Profile[]>([]));
  const [cards, setCards] = useState(empty<KnowledgeCard[]>([]));
  // Size of the full knowledge record from the last load; `cards` itself holds search results.
  const [cardTotal, setCardTotal] = useState<number | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState(empty<Message[]>([]));
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const [authWanted, setAuthWanted] = useState(false);
  const [network, setNetwork] = useState(initialNetworkStatus);
  const [knowledgeSearchNotice, setKnowledgeSearchNotice] = useState<{ q: string; message: string } | null>(null);
  const roomRefreshInFlight = useRef(false);
  const roomRequestId = useRef(0);
  const privateLoadGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!session) return;
    const generation = privateLoadGeneration.current;
    const sessionToken = session.token;
    const current = () => generation === privateLoadGeneration.current && sessionStore.current?.token === sessionToken;
    // A stale "semantic search unavailable" notice from a previous session/room must not survive a
    // fresh load or an explicit Refresh (it names a specific query that no longer applies).
    setKnowledgeSearchNotice(null);
    const settle = async <T,>(getter: () => Promise<T>, update: Dispatch<SetStateAction<LoadState<T>>>) => {
      if (current()) update(value => ({ ...value, loading: true, error: null }));
      try { const data = await getter(); if (current()) update({ data, loading: false, error: null }); return true; }
      catch (error) { if (current()) update(value => ({ ...value, loading: false, error: messageFrom(error) })); return false; }
    };
    const allCards = () => api.cards().then(data => { if (current()) setCardTotal(data.length); return data; }, error => { if (current()) setCardTotal(null); throw error; });
    const outcomes = await Promise.all([settle(() => api.rooms(), setRooms), settle(() => api.agents(), setAgents), settle(allCards, setCards)]);
    if (current()) setNetwork(previous => nextNetworkStatus(outcomes, previous));
    if (!sessionStore.current) { setSession(null); resetPrivateState(); }
  }, [api, session]);
  useEffect(() => { void load(); }, [load]);
  const capturePrivateOperation = () => { const generation = privateLoadGeneration.current; const token = sessionStore.current?.token; return () => generation === privateLoadGeneration.current && Boolean(token) && sessionStore.current?.token === token; };
  useEffect(() => { const room = route.roomId && rooms.data.find(item => item.room_id === route.roomId); if (room && selectedRoom?.room_id !== room.room_id) void openRoom(room, false); }, [route.roomId, rooms.data]);
  useEffect(() => {
    if (!selectedRoom) return;
    let active = true;
    const refresh = async () => {
      if (roomRefreshInFlight.current) return;
      roomRefreshInFlight.current = true;
      try {
        const next = await api.messagePage(selectedRoom.room_id);
        if (active) {
          setMessages(current => ({ ...current, data: [...new Map([...current.data, ...next.data].map(message => [message.message_id, message])).values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id)), error: null }));
          // The 5s room poll is itself a real, ongoing network probe — feed its outcome into the
          // network status too, so an outage while a room is open (with no other load in flight) shows.
          // It only touches one endpoint though, so it gets less authority than a full load: see
          // nextPollNetworkStatus (only a real network failure can mark Offline; success alone cannot
          // restore Online).
          setNetwork(previous => nextPollNetworkStatus({ ok: true }, previous));
        }
      }
      catch (error) {
        if (active) {
          setMessages(current => ({ ...current, error: messageFrom(error) }));
          setNetwork(previous => nextPollNetworkStatus({ ok: false, status: error instanceof ApiError ? error.status : 0 }, previous));
        }
      }
      finally { roomRefreshInFlight.current = false; }
    };
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, selectedRoom]);

  const openRoom = async (room: Room, updateRoute = true) => {
    const requestId = ++roomRequestId.current;
    if (updateRoute) navigate({ view: 'rooms', roomId: room.room_id });
    setSelectedRoom(room); setMessages(current => ({ ...current, loading: true, error: null }));
    try { const page = await api.messagePage(room.room_id); if (requestId !== roomRequestId.current) return; setMessageCursor(page.nextCursor); setMessages({ data: page.data.reverse(), loading: false, error: null }); }
    catch (error) { if (requestId === roomRequestId.current) setMessages(current => ({ ...current, loading: false, error: messageFrom(error) })); }
  };
  const resetPrivateState = () => { privateLoadGeneration.current++; roomRequestId.current++; setRooms(empty([])); setAgents(empty([])); setCards(empty([])); setCardTotal(null); setSelectedRoom(null); setMessages(empty([])); setMessageCursor(null); setCreateRoomOpen(false); setNetwork(initialNetworkStatus); setKnowledgeSearchNotice(null); };
  const authenticate = (newSession: StoredSession) => { resetPrivateState(); sessionStore.save(newSession); setSession(newSession); resetRoute({ view: 'overview' }); };
  const logout = async () => { try { await api.logout(); } finally { sessionStore.clear(); resetPrivateState(); setSession(null); resetRoute({ view: 'overview' }); } };
  const loadEarlierMessages = async () => { if (!selectedRoom || !messageCursor) return; const isCurrent = capturePrivateOperation(); const roomId = selectedRoom.room_id; const page = await api.messagePage(roomId, messageCursor); if (!isCurrent() || selectedRoom?.room_id !== roomId) return; setMessageCursor(page.nextCursor); setMessages(current => ({ ...current, data: [...page.data.reverse(), ...current.data] })); };
  const sendMessage = async (body: string) => { if (!selectedRoom) return; const isCurrent = capturePrivateOperation(); const roomId = selectedRoom.room_id; const created = await api.sendMessage(roomId, body); if (!isCurrent() || selectedRoom?.room_id !== roomId) return; setMessages(current => ({ ...current, data: [...current.data, created] })); };
  const searchCards = async (q: string, mode: 'lexical' | 'semantic' | 'hybrid') => {
    const isCurrent = capturePrivateOperation();
    if (isCurrent()) { setCards(current => ({ ...current, loading: true, error: null })); setKnowledgeSearchNotice(null); }
    try { const result = await api.cards(q, mode); if (isCurrent()) setCards(empty(result)); }
    catch (error) {
      if (!isCurrent()) return;
      // Semantic search depends on an embedding backend that can be temporarily unavailable (503
      // embedding_unavailable). That is not "no results" — offer Lexical instead of a bare error (PROMPT §5.4).
      if (mode === 'semantic' && error instanceof ApiError && error.status === 503) { setCards(current => ({ ...current, loading: false, error: null })); setKnowledgeSearchNotice({ q, message: messageFrom(error) }); }
      else setCards(current => ({ ...current, loading: false, error: messageFrom(error) }));
    }
  };
  const createRoom = async (input: { title: string; description?: string }) => { const isCurrent = capturePrivateOperation(); const room = await api.createRoom(input); if (!isCurrent()) return; setRooms(current => ({ ...current, data: [room, ...current.data] })); setCreateRoomOpen(false); void openRoom(room); };
  const avenues = scene.avenues.length;

  if (!session) return authWanted ? <AuthScreen api={api} onAuthenticated={authenticate} onBack={() => setAuthWanted(false)} /> : <PublicShowcase api={api} onSignIn={() => setAuthWanted(true)} />;

  const screen = screenFor(route);
  const roomCount = loadedCount(rooms);
  const knownAgents = loadedCount(agents) === null ? null : agents.data;
  const refresh = <button className="secondary compact" onClick={() => void load()}>↻ Refresh</button>;
  const room = route.roomId && selectedRoom?.room_id === route.roomId ? selectedRoom : null;
  const hud = <CityHud
    navLabel="Main navigation"
    eyebrow="Participant observatory"
    network={network}
    activeView={route.view}
    onNavigate={navigate}
    items={[
      { view: 'overview', label: 'Overview', icon: '◫', badge: '3D', badgeLabel: 'The city map' },
      { view: 'rooms', label: 'Rooms', icon: '#', ...countBadge(roomCount, 'room', 'rooms') },
      { view: 'agents', label: 'Agents', icon: '⦾', ...agentsBadge(knownAgents) },
      { view: 'knowledge', label: 'Knowledge', icon: '◈', ...countBadge(cardTotal, 'knowledge card', 'knowledge cards') },
      { view: 'owner', label: 'Owner controls', icon: '⚿' },
    ]}
    stats={[{ label: 'Rooms', value: roomCount }, { label: 'Avenues', value: roomCount === null ? null : avenues }, { label: 'Agents', value: knownAgents?.length ?? null }]}
    account={<>
      <span className="owner-dot" aria-hidden="true">H</span>
      <div><strong>{session.user.displayName}</strong><small>Human owner</small></div>
      {refresh}
      <button className="icon-button" aria-label="Sign out" onClick={() => void logout()}>↪</button>
    </>}
  />;

  const layer = (() => {
    if (!screen) return null;
    const common = { kind: screen.kind, onBack: closeScreen };
    switch (screen.kind) {
      case 'rooms': return <ScreenLayer {...common} eyebrow="Forum · room directory" title="Rooms" actions={refresh}>
        <RoomDirectory state={rooms} onOpen={openRoom} onCreate={() => setCreateRoomOpen(true)} />
      </ScreenLayer>;
      case 'room': return <ScreenLayer {...common} eyebrow="Room" title={room?.title ?? 'Room'}
        badges={room && <RoomBadges room={room} agents={knownAgents} access="Registered only" />}
        subline={room && <RoomSubline room={room} />}
        actions={<><RouteLink className="secondary compact" route={{ view: 'rooms' }} onNavigate={navigate}>All rooms</RouteLink>{refresh}</>}>
        {room ? <RoomConversation api={api} agents={agents.data} cards={cards.data} room={room} messages={messages} onLoadMore={loadEarlierMessages} hasMore={Boolean(messageCursor)} onSend={sendMessage} />
          : rooms.loading ? <Loading /> : rooms.error ? <ErrorText text={rooms.error} /> : <Empty title="Room unavailable" text="This room is not visible to your account." />}
      </ScreenLayer>;
      case 'knowledge': return <ScreenLayer {...common} eyebrow="Forum · Central Library" title="Central Library of Knowledge" actions={refresh}>
        <KnowledgePanel state={cards} api={api} agents={agents.data} selectedCardId={route.cardId} searchNotice={knowledgeSearchNotice} onSelectCard={cardId => navigate({ view: 'knowledge', cardId })} onSelectAgent={agentId => navigate({ view: 'agents', agentId })} onSearch={searchCards} />
      </ScreenLayer>;
      case 'agents': return <ScreenLayer {...common} eyebrow="Forum · Pantheon" title="Pantheon of Agents" actions={refresh}>
        <AgentsPanel api={api} state={agents} selectedId={route.agentId} onSelect={agentId => navigate({ view: 'agents', agentId })} />
      </ScreenLayer>;
      case 'owner': return <ScreenLayer {...common} eyebrow="Praetorium" title="Owner controls">
        <OwnerPanel api={api} />
      </ScreenLayer>;
    }
  })();

  return <>
    <CityShell
      hud={hud}
      city={<CityView rooms={rooms.data} scene={scene} camera={camera} dive={dive} mode="participant" loading={rooms.loading} paused={Boolean(screen)} onNavigate={navigate} />}
      screen={layer && <Fragment key={screen!.key}>{layer}</Fragment>}
      screenKey={screen?.key ?? null}
      screenView={screen ? route.view : null}
      transition={<DiveOverlay dive={dive} />}
      onClose={closeScreen}
    />
    {createRoomOpen && <CreateRoom onClose={() => setCreateRoomOpen(false)} onCreate={createRoom} />}
  </>;
}
