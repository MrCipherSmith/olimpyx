import { useCallback, useEffect, useState } from 'react';
import type { OlimpyxApi, PublicAgent, PublicKnowledgeCard, PublicMessage, PublicRoom, ShowcaseSnapshot } from '../../lib/api';
import { messageFrom } from '../../lib/format';
import { empty, type LoadState } from '../../lib/loadState';
import { hrefFor, readRoute, type Route } from '../../lib/navigation';
import { CityView } from '../city/CityView';
import { ShowcaseSidebar } from '../layout/ShowcaseSidebar';
import { ShowcaseTopbar } from '../layout/ShowcaseTopbar';
import { ErrorText } from '../shared/ErrorText';
import { Loading } from '../shared/Loading';
import { PublicAgents } from './PublicAgents';
import { PublicKnowledge } from './PublicKnowledge';
import { PublicOverview } from './PublicOverview';
import { PublicRooms } from './PublicRooms';

export function PublicShowcase({ api, onSignIn }: { api: OlimpyxApi; onSignIn: () => void }) {
  const [route, setRoute] = useState<Route>(() => { const initial = readRoute(window.location.search); return initial.view === 'owner' ? { view: 'overview' } : initial; });
  useEffect(() => { const content = document.querySelector('.content'); if (content) content.scrollTop = 0; }, [route]);
  const [snapshot, setSnapshot] = useState<LoadState<ShowcaseSnapshot | null>>(empty(null));
  const [roomMessages, setRoomMessages] = useState<LoadState<PublicMessage[]>>(empty([]));
  const [roomDetail, setRoomDetail] = useState<LoadState<PublicRoom | null>>(empty(null));
  const [cardDetail, setCardDetail] = useState<LoadState<PublicKnowledgeCard | null>>(empty(null));
  const [agentDetail, setAgentDetail] = useState<LoadState<PublicAgent | null>>(empty(null));
  const [historyRevision, setHistoryRevision] = useState(0);

  const load = useCallback(async () => {
    setSnapshot(current => ({ ...current, loading: true, error: null }));
    try { setSnapshot(empty(await api.showcase())); }
    catch (error) { setSnapshot(current => ({ ...current, loading: false, error: messageFrom(error) })); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const restore = () => { const next = readRoute(window.location.search); setRoute(next.view === 'owner' ? { view: 'overview' } : next); }; window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore); }, []);
  useEffect(() => { if (!route.roomId || snapshot.data?.rooms.some(room => room.room_id === route.roomId)) { setRoomDetail(empty(null)); return; } let active = true; setRoomDetail({ data: null, loading: true, error: null }); void api.showcaseRoom(route.roomId).then(room => { if (active) setRoomDetail(empty(room)); }).catch(error => { if (active) setRoomDetail({ data: null, loading: false, error: messageFrom(error) }); }); return () => { active = false; }; }, [api, route.roomId, snapshot.data]);
  useEffect(() => { if (!route.cardId || snapshot.data?.knowledge_cards.some(card => card.card_id === route.cardId)) { setCardDetail(empty(null)); return; } let active = true; setCardDetail({ data: null, loading: true, error: null }); void api.showcaseCard(route.cardId).then(card => { if (active) setCardDetail(empty(card)); }).catch(error => { if (active) setCardDetail({ data: null, loading: false, error: messageFrom(error) }); }); return () => { active = false; }; }, [api, route.cardId, snapshot.data]);
  useEffect(() => { if (!route.agentId || snapshot.data?.agents.some(agent => agent.agent_id === route.agentId)) { setAgentDetail(empty(null)); return; } let active = true; setAgentDetail({ data: null, loading: true, error: null }); void api.showcaseAgent(route.agentId).then(agent => { if (active) setAgentDetail(empty(agent)); }).catch(error => { if (active) setAgentDetail({ data: null, loading: false, error: messageFrom(error) }); }); return () => { active = false; }; }, [api, route.agentId, snapshot.data]);
  useEffect(() => {
    if (!route.roomId) { setRoomMessages(empty([])); return; }
    let active = true;
    setRoomMessages(current => ({ ...current, loading: true, error: null }));
    void api.showcaseMessages(route.roomId).then(page => { if (active) setRoomMessages(empty(page.data.slice().reverse())); }).catch(error => { if (active) setRoomMessages({ data: [], loading: false, error: messageFrom(error) }); });
    return () => { active = false; };
    // Refetch on the room change or an explicit Refresh only. Refetching when the first snapshot arrives
    // swapped the history for a spinner right after a #message-… anchor had been applied, losing it.
  }, [api, route.roomId, historyRevision]);

  const navigate = (next: Route) => { window.history.pushState(null, '', hrefFor(next)); setRoute(next); };
  const data = snapshot.data;
  const selectedRoom = route.roomId ? data?.rooms.find(room => room.room_id === route.roomId) ?? roomDetail.data ?? undefined : undefined;
  const selectedCard = route.cardId ? data?.knowledge_cards.find(card => card.card_id === route.cardId) ?? cardDetail.data ?? undefined : undefined;
  const selectedAgent = route.agentId ? data?.agents.find(agent => agent.agent_id === route.agentId) ?? agentDetail.data ?? undefined : undefined;

  return <main className={`app-shell public-showcase${route.view === 'rooms' ? ` rooms-shell${route.roomId ? ' room-open' : ''}` : ''}`}>
    <ShowcaseSidebar route={route} onNavigate={navigate} onSignIn={onSignIn} />
    <section className="content">
      <ShowcaseTopbar route={route} data={data} onNavigate={navigate} onRefresh={() => { setHistoryRevision(revision => revision + 1); void load(); }} onSignIn={onSignIn} />
      {snapshot.loading && !data && <Loading />}
      {snapshot.error && !data && <ErrorText text={snapshot.error} />}
      {data && route.view === 'overview' && <PublicOverview data={data} onNavigate={navigate} />}
      {data && route.view === 'city' && <CityView rooms={data.rooms} agents={data.agents} cardCount={data.knowledge_cards.length} mode="guest" onNavigate={navigate} />}
      {data && route.view === 'rooms' && <PublicRooms data={data} selected={selectedRoom} messages={roomMessages} onNavigate={navigate} />}
      {data && route.view === 'agents' && <PublicAgents data={data} selected={selectedAgent} onNavigate={navigate} />}
      {data && route.view === 'knowledge' && <PublicKnowledge data={data} selected={selectedCard} onNavigate={navigate} />}
      {route.roomId && roomDetail.loading && <Loading />}{route.roomId && roomDetail.error && <ErrorText text="This room is unavailable in the public showcase." />}
      {route.cardId && cardDetail.loading && <Loading />}{route.cardId && cardDetail.error && <ErrorText text="This knowledge card is unavailable in the public showcase." />}
      {route.agentId && agentDetail.loading && <Loading />}{route.agentId && agentDetail.error && <ErrorText text="This agent is unavailable in the public showcase." />}
      {snapshot.error && data && <ErrorText text={`Refresh failed: ${snapshot.error}`} />}
    </section>
  </main>;
}
