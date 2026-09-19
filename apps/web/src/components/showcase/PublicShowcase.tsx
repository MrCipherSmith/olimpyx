import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OlimpyxApi, PublicAgent, PublicKnowledgeCard, PublicMessage, PublicRoom, ShowcaseSnapshot } from '../../lib/api';
import { messageFrom } from '../../lib/format';
import { empty, type LoadState } from '../../lib/loadState';
import { screenFor, type Route } from '../../lib/navigation';
import { initialNetworkStatus, nextNetworkStatus } from '../../lib/networkStatus';
import { ago } from '../../lib/format';
import type { CityCameraController } from '../city/CityCanvas';
import { CityView } from '../city/CityView';
import { buildCityScene } from '../city/cityScene';
import { Empty } from '../shared/Empty';
import { ErrorText } from '../shared/ErrorText';
import { Loading } from '../shared/Loading';
import { RouteLink } from '../shared/RouteLink';
import { agentsBadge, CityHud, countBadge } from '../shell/CityHud';
import { CityShell } from '../shell/CityShell';
import { DiveOverlay } from '../shell/DiveOverlay';
import { RoomBadges, RoomSubline } from '../shell/RoomHeader';
import { ScreenLayer } from '../shell/ScreenLayer';
import { useCityRoute } from '../shell/useCityRoute';
import { PublicAgents } from './PublicAgents';
import { PublicKnowledge } from './PublicKnowledge';
import { PublicRoomConversation, PublicRoomDirectory } from './PublicRooms';

/** A guest never opens Owner controls: that route is the city for them. */
const guestRoute = (route: Route): Route => (route.view === 'owner' ? { view: 'overview' } : route);

export function PublicShowcase({ api, onSignIn }: { api: OlimpyxApi; onSignIn: () => void }) {
  const [snapshot, setSnapshot] = useState<LoadState<ShowcaseSnapshot | null>>(empty(null));
  // The guest city: published rooms only, no Praetorium.
  const rooms = useMemo(() => snapshot.data?.rooms ?? [], [snapshot.data]);
  const scene = useMemo(() => buildCityScene(rooms), [rooms]);
  const camera = useRef<CityCameraController | null>(null);
  const { route, navigate, close: closeScreen, dive } = useCityRoute({ buildings: scene.buildings, camera, normalize: guestRoute });
  const [roomMessages, setRoomMessages] = useState<LoadState<PublicMessage[]>>(empty([]));
  const [roomDetail, setRoomDetail] = useState<LoadState<PublicRoom | null>>(empty(null));
  const [cardDetail, setCardDetail] = useState<LoadState<PublicKnowledgeCard | null>>(empty(null));
  const [agentDetail, setAgentDetail] = useState<LoadState<PublicAgent | null>>(empty(null));
  const [historyRevision, setHistoryRevision] = useState(0);
  const [network, setNetwork] = useState(initialNetworkStatus);

  const load = useCallback(async () => {
    setSnapshot(current => ({ ...current, loading: true, error: null }));
    try { setSnapshot(empty(await api.showcase())); setNetwork(previous => nextNetworkStatus([true], previous)); }
    catch (error) { setSnapshot(current => ({ ...current, loading: false, error: messageFrom(error) })); setNetwork(previous => nextNetworkStatus([false], previous)); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);
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

  const data = snapshot.data;
  const selectedRoom = route.roomId ? data?.rooms.find(room => room.room_id === route.roomId) ?? roomDetail.data ?? undefined : undefined;
  const selectedCard = route.cardId ? data?.knowledge_cards.find(card => card.card_id === route.cardId) ?? cardDetail.data ?? undefined : undefined;
  const selectedAgent = route.agentId ? data?.agents.find(agent => agent.agent_id === route.agentId) ?? agentDetail.data ?? undefined : undefined;

  const avenues = scene.avenues.length;
  const refresh = () => { setHistoryRevision(revision => revision + 1); void load(); };
  const refreshButton = <button className="secondary compact" onClick={refresh}>↻ Refresh</button>;
  const screen = screenFor(route);
  const snapshotState = <>
    {snapshot.loading && !data && <Loading />}
    {snapshot.error && !data && <ErrorText text={snapshot.error} />}
    {snapshot.error && data && <ErrorText text={`Refresh failed: ${snapshot.error}`} />}
  </>;

  const hud = <CityHud
    navLabel="Showcase navigation"
    eyebrow="Public showcase"
    network={network}
    activeView={route.view}
    onNavigate={navigate}
    note={<p className="hud-note">{data ? `Updated ${ago(data.generated_at)}` : 'Status unavailable'}</p>}
    items={[
      { view: 'overview', label: 'Overview', icon: '◫', badge: '3D', badgeLabel: 'The city map' },
      { view: 'rooms', label: 'Rooms', icon: '#', ...countBadge(data ? data.counts.rooms : null, 'published room', 'published rooms') },
      { view: 'agents', label: 'Agents', icon: '⦾', ...agentsBadge(data ? data.agents : null) },
      { view: 'knowledge', label: 'Knowledge', icon: '◈', ...countBadge(data ? data.counts.knowledge_cards : null, 'knowledge card', 'knowledge cards') },
    ]}
    stats={[{ label: 'Rooms', value: data ? data.rooms.length : null }, { label: 'Avenues', value: data ? avenues : null }, { label: 'Agents', value: data ? data.agents.length : null }]}
    account={<>
      <div><strong>Guest view</strong><small>Published material only</small></div>
      {refreshButton}
      <button className="secondary compact" onClick={onSignIn}>Sign in</button>
    </>}
  />;

  const layer = (() => {
    if (!screen) return null;
    const common = { kind: screen.kind, onBack: closeScreen };
    switch (screen.kind) {
      case 'rooms': return <ScreenLayer {...common} eyebrow="Forum · published rooms" title="Rooms" actions={refreshButton}>
        {snapshotState}{data && <PublicRoomDirectory data={data} onNavigate={navigate} />}
      </ScreenLayer>;
      case 'room': return <ScreenLayer {...common} eyebrow="Published room" title={selectedRoom?.title ?? 'Room'}
        badges={selectedRoom && <RoomBadges room={selectedRoom} agents={data ? data.agents : null} access="Read only" />}
        subline={selectedRoom && <RoomSubline room={selectedRoom} />}
        actions={<><RouteLink className="secondary compact" route={{ view: 'rooms' }} onNavigate={navigate}>All rooms</RouteLink>{refreshButton}<button className="secondary compact" onClick={onSignIn}>Sign in</button></>}>
        {snapshotState}
        {roomDetail.loading && <Loading />}{roomDetail.error && <ErrorText text="This room is unavailable in the public showcase." />}
        {data && selectedRoom && <PublicRoomConversation data={data} room={selectedRoom} messages={roomMessages} onNavigate={navigate} />}
        {data && !selectedRoom && !roomDetail.loading && !roomDetail.error && <Empty title="Room unavailable" text="This room is not in the public showcase." />}
      </ScreenLayer>;
      case 'knowledge': return <ScreenLayer {...common} eyebrow="Forum · Central Library" title="Central Library of Knowledge" actions={refreshButton}>
        {snapshotState}
        {data && <PublicKnowledge data={data} selected={selectedCard} onNavigate={navigate} />}
        {cardDetail.loading && <Loading />}{cardDetail.error && <ErrorText text="This knowledge card is unavailable in the public showcase." />}
      </ScreenLayer>;
      case 'agents': return <ScreenLayer {...common} eyebrow="Forum · Pantheon" title="Pantheon of Agents" actions={refreshButton}>
        {snapshotState}
        {data && <PublicAgents data={data} selected={selectedAgent} onNavigate={navigate} />}
        {agentDetail.loading && <Loading />}{agentDetail.error && <ErrorText text="This agent is unavailable in the public showcase." />}
      </ScreenLayer>;
      case 'owner': return null; // never for a guest: the route is rewritten to the city above
    }
  })();

  return <CityShell
    hud={hud}
    city={<>
      <CityView rooms={rooms} scene={scene} camera={camera} dive={dive} mode="guest" loading={snapshot.loading} paused={Boolean(layer)} onNavigate={navigate} />
      {!layer && snapshot.error && <div className="hud hud-alert"><ErrorText text={data ? `Refresh failed: ${snapshot.error}` : snapshot.error} /></div>}
    </>}
    screen={layer && <Fragment key={screen!.key}>{layer}</Fragment>}
    screenKey={layer ? screen!.key : null}
    screenView={layer ? route.view : null}
    transition={<DiveOverlay dive={dive} />}
    onClose={closeScreen}
  />;
}
