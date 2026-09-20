import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OlimpyxApi, PublicAgent, PublicKnowledgeCard, PublicMessage, PublicRoom, ShowcaseSnapshot } from '../../lib/api';
import { messageFrom } from '../../lib/format';
import { empty, type LoadState } from '../../lib/loadState';
import { screenFor, type Route } from '../../lib/navigation';
import { initialNetworkStatus, nextNetworkStatus } from '../../lib/networkStatus';
import { ago } from '../../lib/format';
import { useT } from '../../i18n';
import type { CityCameraController } from '../city/CityCanvas';
import { CityView } from '../city/CityView';
import { buildCityScene } from '../city/cityScene';
import { inhabitantActivityFromShowcase } from '../city/inhabitants';
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
/** Stable reference so CityView/CityCanvas don't see "new" inhabitants inputs on every render before load. */
const NO_AGENTS: readonly PublicAgent[] = [];

export function PublicShowcase({ api, onSignIn }: { api: OlimpyxApi; onSignIn: () => void }) {
  const { t } = useT();
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
  // City Shell §6: recent_activity's message entries are the real, already-loaded agent↔room links.
  const inhabitantActivity = useMemo(() => (data ? inhabitantActivityFromShowcase(data.recent_activity) : []), [data]);
  const refresh = () => { setHistoryRevision(revision => revision + 1); void load(); };
  const refreshButton = <button className="secondary compact" onClick={refresh}>↻ {t('hud.account.refresh')}</button>;
  const screen = screenFor(route);
  const snapshotState = <>
    {snapshot.loading && !data && <Loading />}
    {snapshot.error && !data && <ErrorText text={snapshot.error} />}
    {snapshot.error && data && <ErrorText text={t('hud.notes.refreshFailed', { error: snapshot.error })} />}
  </>;

  const hud = <CityHud
    navLabel={t('nav.showcase')}
    eyebrow={t('hud.eyebrow.showcase')}
    network={network}
    activeView={route.view}
    onNavigate={navigate}
    note={<p className="hud-note">{data ? t('hud.notes.updated', { ago: ago(data.generated_at) }) : t('hud.notes.statusUnavailable')}</p>}
    items={[
      { view: 'overview', label: t('hud.navItems.overview'), icon: '◫', badge: '3D', badgeLabel: t('hud.badge.map') },
      { view: 'rooms', label: t('hud.navItems.rooms'), icon: '#', ...countBadge(data ? data.counts.rooms : null, t('hud.badge.publishedRoom'), t('hud.badge.publishedRooms')) },
      { view: 'agents', label: t('hud.navItems.agents'), icon: '⦾', ...agentsBadge(data ? data.agents : null, data ? t('hud.badge.agentsOnline', { online: data.agents.filter(agent => agent.presence === 'online').length, total: data.agents.length }) : null) },
      { view: 'knowledge', label: t('hud.navItems.knowledge'), icon: '◈', ...countBadge(data ? data.counts.knowledge_cards : null, t('hud.badge.knowledgeCard'), t('hud.badge.knowledgeCards')) },
    ]}
    stats={[
      { label: t('hud.stats.rooms'), value: data ? data.rooms.length : null },
      { label: t('hud.stats.avenues'), value: data ? avenues : null },
      { label: t('hud.stats.agents'), value: data ? data.agents.length : null },
    ]}
    account={<>
      <div><strong>{t('hud.account.guestView')}</strong><small>{t('hud.account.publishedOnly')}</small></div>
      {refreshButton}
      <button className="secondary compact" onClick={onSignIn}>{t('hud.account.signIn')}</button>
    </>}
  />;

  const layer = (() => {
    if (!screen) return null;
    const common = { kind: screen.kind, onBack: closeScreen };
    switch (screen.kind) {
      case 'rooms': return <ScreenLayer {...common} eyebrow={t('showcase.publicRoomsEyebrow')} title={t('rooms.title')} actions={refreshButton}>
        {snapshotState}{data && <PublicRoomDirectory data={data} onNavigate={navigate} />}
      </ScreenLayer>;
      case 'room': return <ScreenLayer {...common} eyebrow={t('showcase.sections.room.eyebrow')} title={selectedRoom?.title ?? t('rooms.roomEyebrow')}
        badges={selectedRoom && <RoomBadges room={selectedRoom} agents={data ? data.agents : null} access="guest" />}
        subline={selectedRoom && <RoomSubline room={selectedRoom} />}
        actions={<><RouteLink className="secondary compact" route={{ view: 'rooms' }} onNavigate={navigate}>{t('showcase.allRooms')}</RouteLink>{refreshButton}<button className="secondary compact screen-signin" onClick={onSignIn}>{t('showcase.signIn')}</button></>}>
        {snapshotState}
        {roomDetail.loading && <Loading />}{roomDetail.error && <ErrorText text={t('showcase.roomUnavailableDataText')} />}
        {data && selectedRoom && <PublicRoomConversation data={data} room={selectedRoom} messages={roomMessages} onNavigate={navigate} />}
        {data && !selectedRoom && !roomDetail.loading && !roomDetail.error && <Empty title={t('showcase.roomUnavailable')} text={t('showcase.roomUnavailableText')} />}
      </ScreenLayer>;
      case 'knowledge': return <ScreenLayer {...common} eyebrow={t('knowledge.eyebrow')} title={t('knowledge.title')} actions={refreshButton}>
        {snapshotState}
        {data && <PublicKnowledge data={data} selected={selectedCard} onNavigate={navigate} />}
        {cardDetail.loading && <Loading />}{cardDetail.error && <ErrorText text={t('showcase.cardUnavailableText')} />}
      </ScreenLayer>;
      case 'agents': return <ScreenLayer {...common} eyebrow={t('agents.eyebrow')} title={t('agents.title')} actions={refreshButton}>
        {snapshotState}
        {data && <PublicAgents data={data} selected={selectedAgent} onNavigate={navigate} />}
        {agentDetail.loading && <Loading />}{agentDetail.error && <ErrorText text={t('showcase.agentUnavailableText')} />}
      </ScreenLayer>;
      case 'owner': return null; // never for a guest: the route is rewritten to the city above
    }
  })();

  return <CityShell
    hud={hud}
    city={<>
      <CityView rooms={rooms} scene={scene} camera={camera} dive={dive} mode="guest" loading={snapshot.loading} paused={Boolean(layer)} onNavigate={navigate} agents={data ? data.agents : NO_AGENTS} activity={inhabitantActivity} />
      {!layer && snapshot.error && <div className="hud hud-alert"><ErrorText text={data ? t('hud.notes.refreshFailed', { error: snapshot.error }) : snapshot.error} /></div>}
    </>}
    screen={layer && <Fragment key={screen!.key}>{layer}</Fragment>}
    screenKey={layer ? screen!.key : null}
    screenView={layer ? route.view : null}
    transition={<DiveOverlay dive={dive} />}
    onClose={closeScreen}
  />;
}
