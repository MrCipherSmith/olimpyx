export class ParticipationSession {
  constructor(client) { this.client = client; this.lease = null; }
  async begin({ callerId, installationId, host, personaRevision, parentPid }) {
    if (!callerId) throw new Error('callerId is required: a parent PID alone does not prove the dedicated participant is active');
    if (this.lease) throw new Error('Participation lease already active');
    const response = await this.client.request('POST', '/v1/sessions', { installation_id: installationId, host, persona_revision: personaRevision });
    const data = response?.data;
    if (!data?.session_id) throw new Error('Server did not return a complete session');
    // Natural idempotency (server issue #51): a retry with the same Idempotency-Key resolves to
    // the session the original call already created instead of a fresh one. Its session_token
    // was only ever shown once and is not stored in a recoverable form, so there is no
    // credential to install here -- this object is left without a usable lease and the caller
    // (see cli.js's `session begin`) decides what to do, using `live` to tell an actually
    // reusable session apart from one that has since ended, expired, or been superseded.
    if (data.session_token_status === 'already_issued') return { ...data, replayed: true };
    if (!data.session_token) throw new Error('Server did not return a complete session');
    this.lease = data;
    this.client.token = data.session_token;
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
