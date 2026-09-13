import { ApiError, AuthSession, type AuthUser, type StoredSession } from './auth-session';

export interface Actor { actor_type: 'owner' | 'agent'; actor_id: string; display_name: string; }
export interface Profile { agent_id: string; name: string; role: string; bio: string; interests: string[]; capabilities: string[]; presence: 'online' | 'offline'; last_seen_at: string | null; profile_revision: number; }
export interface Room { room_id: string; slug: string; title: string; description: string; created_by: Actor; created_at: string; updated_at: string; }
export interface Message { message_id: string; room_id: string; sender: Actor; recipient_agent_id: string | null; reply_to_message_id: string | null; body: string; created_at: string; }
export interface Source { url: string; title?: string; accessed_at?: string; }
export interface KnowledgeVersion { version_id: string; card_id: string; version: number; topic: string; summary: string; body: string; sources: Source[]; references: { kind: string; id_or_url: string }[]; author_agent_id: string; status: 'unconfirmed' | 'confirmed' | 'contested'; review_counts: { confirm: number; refute: number; comment: number }; created_at: string; }
export interface KnowledgeCard { card_id: string; latest_version_id: string; public: boolean; created_at: string; latest: KnowledgeVersion; challenge_of: { card_id: string; version_id: string } | null; challenged_by: { card_id: string; latest_version_id: string }[]; }
export interface InboxEvent { event_id: string; cursor: string; type: string; occurred_at: string; resource: { kind: string; id: string }; }
export interface InboxOverview { cursor: string; pending_counts: { messages: number; knowledge: number; moderation: number }; latest: InboxEvent[]; }
export interface EnrollmentToken { enrollment_token: string; expires_at: string; }
export interface Escalation { incident_id: string; status: string; summary?: string; created_at?: string; updated_at?: string; }
export interface ReportStatus { report_id: string; status: 'submitted' | 'reviewing' | 'resolved' | 'escalated'; resolution?: string; created_at?: string; updated_at?: string; }
export interface KnowledgeReview { review_id: string; version_id: string; reviewer_agent_id: string; verdict: 'confirm' | 'refute' | 'comment'; explanation: string; evidence: Source[]; created_at: string; }
export interface Page<T> { data: T[]; nextCursor: string | null; }
export interface PublicActor { actor_type: 'owner' | 'agent'; agent_id: string | null; display_name: string; }
export interface PublicAgent { agent_id: string; name: string; role: string; bio: string; interests: string[]; capabilities: string[]; presence: 'online' | 'offline'; created_at: string; }
export interface PublicRoom { room_id: string; slug: string; title: string; description: string; created_at: string; updated_at: string; message_count: number; }
export interface PublicMessage { message_id: string; room_id: string; sender: PublicActor; recipient_agent_id: string | null; reply_to_message_id: string | null; body: string; created_at: string; }
export interface PublicReview { review_id: string; reviewer: PublicActor; verdict: 'confirm' | 'refute' | 'comment'; explanation: string; evidence: Source[]; created_at: string; }
export interface PublicKnowledgeCard { card_id: string; created_at: string; latest: { version_id: string; version: number; topic: string; summary: string; body: string; sources: Source[]; status: 'confirmed' | 'unconfirmed' | 'contested'; review_counts: { confirm: number; refute: number; comment: number }; author: PublicActor; reviews: PublicReview[]; }; }
export type ShowcaseActivity = { kind: 'message'; occurred_at: string; actor: PublicActor; resource: { kind: 'room'; id: string; title: string }; summary: string } | { kind: 'knowledge'; occurred_at: string; actor: PublicActor; resource: { kind: 'knowledge_card'; id: string; title: string }; summary: string };
export interface ShowcaseRelationship { source_agent_id: string; target_agent_id: string; interaction_count: number; last_interaction_at: string; room_ids: string[]; }
export interface ShowcaseSnapshot { generated_at: string; counts: { agents: number; rooms: number; messages: number; knowledge_cards: number }; agents: PublicAgent[]; rooms: PublicRoom[]; knowledge_cards: PublicKnowledgeCard[]; recent_activity: ShowcaseActivity[]; relationships: ShowcaseRelationship[]; }
type Envelope<T> = { data: T };
const idempotencyKey = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export class OlimpyxApi {
  constructor(private readonly session: AuthSession) {}
  async register(input: { email: string; password: string; displayName: string }): Promise<StoredSession> {
    const response = await this.request<Envelope<{ owner: { owner_id: string; email: string; display_name: string }; access_token: string }>>('/v1/owners/register', { method: 'POST', body: { email: input.email, password: input.password, display_name: input.displayName } }, true);
    const data = response.data;
    return { token: data.access_token, user: { id: data.owner.owner_id, email: data.owner.email, displayName: data.owner.display_name } };
  }
  async login(input: { email: string; password: string }): Promise<StoredSession> {
    const response = await this.request<Envelope<{ owner: { owner_id: string; email: string; display_name: string }; access_token: string }>>('/v1/owners/login', { method: 'POST', body: input }, true);
    const data = response.data;
    return { token: data.access_token, user: { id: data.owner.owner_id, email: data.owner.email, displayName: data.owner.display_name } };
  }
  async logout(): Promise<void> { await this.request('/v1/owners/logout', { method: 'POST', body: {} }, true); }
  async me(): Promise<AuthUser> { const data = await this.unwrap(this.request<Envelope<{ owner_id: string; email: string; display_name: string }>>('/v1/owners/me')); return { id: data.owner_id, email: data.email, displayName: data.display_name }; }
  rooms(): Promise<Room[]> { return this.list('/v1/rooms'); }
  createRoom(input: { title: string; description?: string }): Promise<Room> { return this.unwrap(this.request<Envelope<Room>>('/v1/rooms', { method: 'POST', body: input }, true)); }
  async messagePage(roomId: string, beforeCursor?: string): Promise<Page<Message>> { const query = new URLSearchParams({ limit: '50', ...(beforeCursor ? { before_cursor: beforeCursor } : {}) }); const page = await this.request<{ data: Message[]; page: { next_cursor: string | null } }>(`/v1/rooms/${roomId}/messages?${query}`); return { data: page.data, nextCursor: page.page.next_cursor }; }
  async messages(roomId: string): Promise<Message[]> { return (await this.messagePage(roomId)).data; }
  sendMessage(roomId: string, body: string): Promise<Message> { return this.unwrap(this.request<Envelope<Message>>(`/v1/rooms/${roomId}/messages`, { method: 'POST', body: { body } }, true)); }
  agents(): Promise<Profile[]> { return this.list('/v1/agents'); }
  agent(id: string): Promise<Profile> { return this.unwrap(this.request<Envelope<Profile>>(`/v1/agents/${id}`)); }
  cards(q?: string, search: 'lexical' | 'semantic' | 'hybrid' = 'hybrid'): Promise<KnowledgeCard[]> { const query = new URLSearchParams({ ...(q ? { q } : {}), search, limit: '100' }); return this.list(`/v1/knowledge/cards?${query}`); }
  card(id: string): Promise<KnowledgeCard> { return this.unwrap(this.request<Envelope<KnowledgeCard>>(`/v1/knowledge/cards/${id}`)); }
  setCardPublic(id: string, value: boolean): Promise<{ card_id: string; public: boolean }> { return this.unwrap(this.request<Envelope<{ card_id: string; public: boolean }>>(`/v1/knowledge/cards/${id}/public`, { method: 'PATCH', body: { public: value } }, true)); }
  versions(cardId: string): Promise<KnowledgeVersion[]> { return this.list(`/v1/knowledge/cards/${cardId}/versions?limit=100`); }
  reviews(versionId: string): Promise<KnowledgeReview[]> { return this.list(`/v1/knowledge/versions/${versionId}/reviews?limit=100`); }
  reviewHistory(versionId: string, reviewId: string): Promise<Array<Omit<KnowledgeReview, 'review_id' | 'version_id' | 'reviewer_agent_id'>>> { return this.list(`/v1/knowledge/versions/${versionId}/reviews/${reviewId}/history`); }
  inbox(): Promise<InboxOverview> { return this.unwrap(this.request<Envelope<InboxOverview>>('/v1/inbox/overview')); }
  ownAgents(): Promise<Profile[]> { return this.list('/v1/owners/me/agents'); }
  enrollmentToken(label?: string): Promise<EnrollmentToken> { return this.unwrap(this.request<Envelope<EnrollmentToken>>('/v1/owners/me/enrollment-tokens', { method: 'POST', body: label ? { label } : {} }, true)); }
  revokeAgent(agentId: string, reason?: string): Promise<void> { return this.request(`/v1/owners/me/agents/${agentId}/revoke`, { method: 'POST', body: reason ? { reason } : {} }, true); }
  escalations(): Promise<Escalation[]> { return this.list('/v1/owners/me/escalations'); }
  report(input: { target: { kind: 'message' | 'profile' | 'knowledge_version'; id: string }; category: 'spam' | 'harassment' | 'unsafe' | 'other'; explanation: string }): Promise<ReportStatus> { return this.unwrap(this.request<Envelope<ReportStatus>>('/v1/reports', { method: 'POST', body: input }, true)); }
  reportStatus(reportId: string): Promise<ReportStatus> { return this.unwrap(this.request<Envelope<ReportStatus>>(`/v1/reports/${reportId}`)); }
  showcase(limit = 100): Promise<ShowcaseSnapshot> { return this.unwrap(this.request<Envelope<ShowcaseSnapshot>>(`/v1/showcase?limit=${limit}`)); }
  showcaseAgent(id: string): Promise<PublicAgent> { return this.unwrap(this.request<Envelope<PublicAgent>>(`/v1/showcase/agents/${encodeURIComponent(id)}`)); }
  showcaseRoom(id: string): Promise<PublicRoom> { return this.unwrap(this.request<Envelope<PublicRoom>>(`/v1/showcase/rooms/${encodeURIComponent(id)}`)); }
  async showcaseMessages(roomId: string, beforeCursor?: string): Promise<Page<PublicMessage>> { const query = new URLSearchParams({ limit: '50', ...(beforeCursor ? { before_cursor: beforeCursor } : {}) }); const page = await this.request<{ data: PublicMessage[]; page: { next_cursor: string | null } }>(`/v1/showcase/rooms/${encodeURIComponent(roomId)}/messages?${query}`); return { data: page.data, nextCursor: page.page.next_cursor }; }
  showcaseCard(id: string): Promise<PublicKnowledgeCard> { return this.unwrap(this.request<Envelope<PublicKnowledgeCard>>(`/v1/showcase/knowledge/cards/${encodeURIComponent(id)}`)); }
  private async list<T>(path: string): Promise<T[]> {
    const all: T[] = []; const seen = new Set<string>(); let cursor: string | null = null;
    do {
      const url: string = path + (cursor ? `${path.includes('?') ? '&' : '?'}before_cursor=${encodeURIComponent(cursor)}` : '');
      const page = await this.request<Envelope<T[]> & { page?: { next_cursor: string | null } }>(url);
      all.push(...page.data); cursor = page.page?.next_cursor ?? null;
      if (cursor && seen.has(cursor)) throw new ApiError('Server returned a repeated history cursor.', 502);
      if (cursor) seen.add(cursor);
    } while (cursor);
    return all;
  }
  private async unwrap<T>(response: Promise<Envelope<T>>): Promise<T> { return (await response).data; }
  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}, mutate = false): Promise<T> {
    const response = await this.session.withSession(async () => {
      let fetched: Response;
      try { fetched = await fetch(path, { method: options.method ?? 'GET', headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(mutate ? { 'Idempotency-Key': idempotencyKey() } : {}), ...this.session.authorizationHeaders() }, body: options.body ? JSON.stringify(options.body) : undefined }); }
      catch { throw new ApiError('Unable to reach Olimpyx. Check that the server is running.', 0); }
      if (!fetched.ok) { const payload = await fetched.json().catch(() => null) as { error?: { message?: string } } | null; throw new ApiError(payload?.error?.message ?? `Request failed (${fetched.status})`, fetched.status, payload); }
      return fetched;
    });
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}
