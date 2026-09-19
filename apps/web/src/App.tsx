import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentsPanel } from './components/agents/AgentsPanel';
import { AuthScreen } from './components/auth/AuthScreen';
import { CityView } from './components/city/CityView';
import { KnowledgePanel } from './components/knowledge/KnowledgePanel';
import { ParticipantSidebar } from './components/layout/ParticipantSidebar';
import { ParticipantTopbar } from './components/layout/ParticipantTopbar';
import { OwnerPanel } from './components/owner/OwnerPanel';
import { ParticipantOverview } from './components/overview/ParticipantOverview';
import { CreateRoom } from './components/rooms/CreateRoom';
import { RoomsPanel } from './components/rooms/RoomsPanel';
import { PublicShowcase } from './components/showcase/PublicShowcase';
import { OlimpyxApi, type KnowledgeCard, type Message, type Profile, type Room } from './lib/api';
import { ApiError, AuthSession, type StoredSession } from './lib/auth-session';
import { messageFrom } from './lib/format';
import { empty, type LoadState } from './lib/loadState';
import { hrefFor, readRoute, type Route } from './lib/navigation';
import { initialNetworkStatus, nextNetworkStatus } from './lib/networkStatus';

/** Root: owns the session, the route and the participant's private data; guests get the public showcase. */
export function App() {
  const sessionStore = useMemo(() => new AuthSession(), []);
  const api = useMemo(() => new OlimpyxApi(sessionStore), [sessionStore]);
  const [session, setSession] = useState<StoredSession | null>(() => sessionStore.current);
  const [route, setRoute] = useState<Route>(() => readRoute(window.location.search));
  const view = route.view;
  useEffect(() => { const content = document.querySelector('.content'); if (content) content.scrollTop = 0; }, [route]);
  const [rooms, setRooms] = useState(empty<Room[]>([]));
  const [agents, setAgents] = useState(empty<Profile[]>([]));
  const [cards, setCards] = useState(empty<KnowledgeCard[]>([]));
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
    const settle = async <T,>(getter: () => Promise<T>, update: Dispatch<SetStateAction<LoadState<T>>>) => {
      if (current()) update(value => ({ ...value, loading: true, error: null }));
      try { const data = await getter(); if (current()) update({ data, loading: false, error: null }); return true; }
      catch (error) { if (current()) update(value => ({ ...value, loading: false, error: messageFrom(error) })); return false; }
    };
    const outcomes = await Promise.all([settle(() => api.rooms(), setRooms), settle(() => api.agents(), setAgents), settle(() => api.cards(), setCards)]);
    if (current()) setNetwork(previous => nextNetworkStatus(outcomes, previous));
    if (!sessionStore.current) { setSession(null); resetPrivateState(); }
  }, [api, session]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const restore = () => setRoute(readRoute(window.location.search)); window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore); }, []);
  const navigate = (next: Route) => { window.history.pushState(null, '', hrefFor(next)); setRoute(next); };
  const capturePrivateOperation = () => { const generation = privateLoadGeneration.current; const token = sessionStore.current?.token; return () => generation === privateLoadGeneration.current && Boolean(token) && sessionStore.current?.token === token; };
  useEffect(() => { const room = route.roomId && rooms.data.find(item => item.room_id === route.roomId); if (room && selectedRoom?.room_id !== room.room_id) void openRoom(room, false); }, [route.roomId, rooms.data]);
  useEffect(() => {
    if (!selectedRoom) return;
    let active = true;
    const refresh = async () => {
      if (roomRefreshInFlight.current) return;
      roomRefreshInFlight.current = true;
      try { const next = await api.messagePage(selectedRoom.room_id); if (active) setMessages(current => ({ ...current, data: [...new Map([...current.data, ...next.data].map(message => [message.message_id, message])).values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id)), error: null })); }
      catch (error) { if (active) setMessages(current => ({ ...current, error: messageFrom(error) })); }
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
  const resetPrivateState = () => { privateLoadGeneration.current++; roomRequestId.current++; setRooms(empty([])); setAgents(empty([])); setCards(empty([])); setSelectedRoom(null); setMessages(empty([])); setMessageCursor(null); setCreateRoomOpen(false); setNetwork(initialNetworkStatus); };
  const authenticate = (newSession: StoredSession) => { resetPrivateState(); sessionStore.save(newSession); setSession(newSession); navigate({ view: 'overview' }); };
  const logout = async () => { try { await api.logout(); } finally { sessionStore.clear(); resetPrivateState(); setSession(null); navigate({ view: 'overview' }); } };
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

  if (!session) return authWanted ? <AuthScreen api={api} onAuthenticated={authenticate} onBack={() => setAuthWanted(false)} /> : <PublicShowcase api={api} onSignIn={() => setAuthWanted(true)} />;
  return <main className={`app-shell${view === 'rooms' ? ` rooms-shell${route.roomId ? ' room-open' : ''}` : ''}`}>
    <ParticipantSidebar view={view} displayName={session.user.displayName} network={network} onNavigate={navigate} onSignOut={() => void logout()} />
    <section className="content">
      <ParticipantTopbar route={route} onNavigate={navigate} onRefresh={() => void load()} />
      {view === 'overview' && <ParticipantOverview rooms={rooms} agents={agents} cards={cards} onNavigate={navigate} />}
      {view === 'city' && <CityView rooms={rooms.data} agents={agents.data} cardCount={cards.data.length} mode="participant" loading={rooms.loading} onNavigate={navigate} />}
      {view === 'rooms' && <RoomsPanel api={api} state={rooms} agents={agents.data} cards={cards.data} selected={route.roomId ? selectedRoom : null} messages={messages} onOpen={openRoom} onCreate={() => setCreateRoomOpen(true)} onLoadMore={loadEarlierMessages} hasMore={Boolean(messageCursor)} onSend={sendMessage} />}
      {view === 'agents' && <AgentsPanel api={api} state={agents} selectedId={route.agentId} onSelect={agentId => navigate({ view: 'agents', agentId })} />}
      {view === 'knowledge' && <KnowledgePanel state={cards} api={api} agents={agents.data} selectedCardId={route.cardId} searchNotice={knowledgeSearchNotice} onSelectCard={cardId => navigate({ view: 'knowledge', cardId })} onSelectAgent={agentId => navigate({ view: 'agents', agentId })} onSearch={searchCards} />}
      {view === 'owner' && <OwnerPanel api={api} />}
    </section>
    {createRoomOpen && <CreateRoom onClose={() => setCreateRoomOpen(false)} onCreate={createRoom} />}
  </main>;
}
