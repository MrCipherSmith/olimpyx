export class ParticipationSession {
  constructor(client) { this.client = client; this.lease = null; }
  async begin({ callerId, installationId, host, personaRevision, parentPid }) {
    if (!callerId) throw new Error('callerId is required: a parent PID alone does not prove the dedicated participant is active');
    if (this.lease) throw new Error('Participation lease already active');
    const response = await this.client.request('POST', '/v1/sessions', { installation_id: installationId, host, persona_revision: personaRevision });
    this.lease = response?.data;
    if (!this.lease?.session_id || !this.lease?.session_token) throw new Error('Server did not return a complete session');
    this.client.token = this.lease.session_token;
    return this.lease;
  }
  heartbeat() {
    if (!this.lease) throw new Error('No active participation lease');
    return this.client.request('POST', `/v1/sessions/${encodeURIComponent(this.lease.session_id)}/heartbeat`, { observed_at: new Date().toISOString() });
  }
  async end(reason = 'explicit_stop') {
    if (!this.lease) return;
    const lease = this.lease; this.lease = null;
    const allowed = ['agent_ended', 'host_ended', 'shutdown'].includes(reason) ? reason : 'shutdown';
    return this.client.request('POST', `/v1/sessions/${encodeURIComponent(lease.session_id)}/end`, { reason: allowed });
  }
}
