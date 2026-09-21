import { chmod, mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function atomicJson(path, value, mode = 0o600) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temp, path);
}

// Sanitise caller-id for use as a directory segment. A caller-id is generated
// by the participant as e.g. `caller-helios-<pid>-<unix>`, so it normally
// contains only [a-z0-9-]. We still strip anything else defensively so a
// hostile caller-id cannot escape the per-caller state directory.
function safeCallerId(callerId) {
  if (typeof callerId !== 'string' || !callerId.trim()) return null;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(callerId)) return null;
  return callerId;
}

export class LocalState {
  constructor(root) { this.root = root; }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, 'persona-revisions'), { recursive: true, mode: 0o700 });
  }
  // Per-caller session directory (F-04): when several participants share one
  // participant home, each caller's session.json / session-credential / pending
  // mutations live under their own subdir so they no longer clobber each other.
  // The home itself is resolved in participant-home.js, never from the cwd.
  async callerDir(callerId) {
    const id = safeCallerId(callerId);
    if (!id) return this.root;
    const dir = join(this.root, 'calls', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  async loadConfig() { return readJson(join(this.root, 'config.json'), {}); }
  async saveConfig(config) { await this.init(); await atomicJson(join(this.root, 'config.json'), config); return config; }
  async loadCredential() { return (await readFile(join(this.root, 'credential'), 'utf8')).trim(); }
  async loadOwnerCredential() { return (await readFile(join(this.root, 'owner-credential'), 'utf8')).trim(); }
  async saveCredential(token) {
    if (!token || /\s/.test(token)) throw new Error('Credential must be a non-empty single-line value');
    await this.init();
    const path = join(this.root, 'credential');
    await writeFile(path, token, { mode: 0o600 }); await chmod(path, 0o600);
  }
  async saveOwnerCredential(token) {
    if (!token || /\s/.test(token)) throw new Error('Credential must be a non-empty single-line value');
    await this.init(); const path = join(this.root, 'owner-credential');
    await writeFile(path, token, { mode: 0o600 }); await chmod(path, 0o600);
  }
  async loadSession(callerId) {
    const dir = await this.callerDir(callerId);
    const metadata = await readJson(join(dir, 'session.json'), null);
    if (!metadata) return null;
    return { ...metadata, token: (await readFile(join(dir, 'session-credential'), 'utf8')).trim() };
  }
  async saveSession(session, callerId, callerLeaseMs = 75_000) {
    if (!session?.session_id || !session?.session_token || !callerId) throw new Error('Complete session and callerId are required');
    const dir = await this.callerDir(callerId);
    const credentialPath = join(dir, 'session-credential');
    await writeFile(credentialPath, session.session_token, { mode: 0o600 }); await chmod(credentialPath, 0o600);
    const metadata = { session_id: session.session_id, expires_at: session.expires_at, caller_id: callerId, caller_deadline: new Date(Date.now() + Math.min(callerLeaseMs, 85_000)).toISOString(), inbox_cursor: session.inbox_cursor ?? null };
    await atomicJson(join(dir, 'session.json'), metadata); return metadata;
  }
  async renewSession(callerId, updates = {}, callerLeaseMs = 75_000) {
    const session = await this.loadSession(callerId);
    if (!session) throw new Error('No local session. Run session begin first.');
    if (session.caller_id !== callerId) throw new Error('callerId does not own this participant session');
    if (Date.parse(session.caller_deadline) <= Date.now()) throw new Error('Local caller lease expired; begin a new session');
    const { token: _token, ...metadata } = session;
    const next = { ...metadata, ...updates, caller_deadline: new Date(Date.now() + Math.min(callerLeaseMs, 85_000)).toISOString() };
    const dir = await this.callerDir(callerId);
    await atomicJson(join(dir, 'session.json'), next); return next;
  }
  async clearSession(callerId) {
    const dir = await this.callerDir(callerId);
    await Promise.all([rm(join(dir, 'session.json'), { force: true }), rm(join(dir, 'session-credential'), { force: true })]);
  }
  async beginMutation(method, path, body, explicitKey, callerId) {
    if (explicitKey !== undefined) {
      if (typeof explicitKey !== 'string' || !explicitKey.trim()) throw new Error('--idempotency-key must be a non-empty value');
      return { fingerprint: null, key: explicitKey };
    }
    const dir = await this.callerDir(callerId);
    const fingerprint = createHash('sha256').update(JSON.stringify({ method: method.toUpperCase(), path, body: body ?? null })).digest('hex');
    const pending = await readJson(join(dir, 'pending-mutations.json'), {});
    if (!pending[fingerprint]) {
      pending[fingerprint] = { key: randomUUID(), method: method.toUpperCase(), path, created_at: new Date().toISOString() };
      await atomicJson(join(dir, 'pending-mutations.json'), pending);
    }
    return { fingerprint, key: pending[fingerprint].key };
  }
  async completeMutation(fingerprint, callerId) {
    if (!fingerprint) return;
    const dir = await this.callerDir(callerId);
    const path = join(dir, 'pending-mutations.json');
    const pending = await readJson(path, {});
    delete pending[fingerprint];
    if (Object.keys(pending).length === 0) await rm(path, { force: true });
    else await atomicJson(path, pending);
  }
  async currentPersona() { return readJson(join(this.root, 'persona.json'), null); }
  async savePersona(persona, reason = 'owner edit') {
    await this.init();
    const current = await this.currentPersona();
    const revision = `${Date.now()}-${crypto.randomUUID()}`;
    const record = { revision, ordinal: Number(current?.ordinal ?? 0) + 1, parent_revision: current?.revision ?? null, created_at: new Date().toISOString(), reason, persona };
    await atomicJson(join(this.root, 'persona-revisions', `${revision}.json`), record);
    await atomicJson(join(this.root, 'persona.json'), record);
    return record;
  }
  async listPersonaRevisions() {
    await this.init();
    const names = (await readdir(join(this.root, 'persona-revisions'))).filter((name) => name.endsWith('.json')).sort();
    const records = await Promise.all(names.map((name) => readJson(join(this.root, 'persona-revisions', name), null)));
    return records.sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0) || a.created_at.localeCompare(b.created_at));
  }
  async rollbackPersona(revision) {
    if (!/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(revision)) throw new Error('Invalid persona revision identifier');
    const record = await readJson(join(this.root, 'persona-revisions', `${revision}.json`), null);
    if (!record) throw new Error(`Persona revision not found: ${revision}`);
    const revisions = await this.listPersonaRevisions();
    const targetIndex = revisions.findIndex((item) => item.revision === revision);
    const laterRevisions = new Set(revisions.slice(targetIndex + 1).map((item) => item.revision));
    const list = await this.influences();
    let changed = false;
    for (let index = 0; index < list.length; index += 1) {
      const belongsToLaterPersona = list[index].persona_revision ? laterRevisions.has(list[index].persona_revision) : list[index].created_at > record.created_at;
      if (list[index].active !== false && belongsToLaterPersona) {
        list[index] = { ...list[index], active: false, archived_at: new Date().toISOString(), archive_reason: `persona rollback to ${revision}` };
        changed = true;
      }
    }
    if (changed) await atomicJson(join(this.root, 'influences.json'), list);
    const restored = await this.savePersona(record.persona, `rollback to ${revision}`);
    return { ...restored, reverted_persona_revisions: [...laterRevisions], target_created_at: record.created_at };
  }
  async pendingMemoryRollbacks() { return readJson(join(this.root, 'pending-memory-rollbacks.json'), []); }
  async savePendingMemoryRollback(entry) {
    if (!entry?.agentId) throw new Error('Cannot save a pending memory rollback without an agentId');
    await this.init();
    const list = await this.pendingMemoryRollbacks();
    const filtered = list.filter((item) => item.idempotencyKey !== entry.idempotencyKey);
    filtered.push({ created_at: new Date().toISOString(), ...entry });
    await atomicJson(join(this.root, 'pending-memory-rollbacks.json'), filtered);
    return entry;
  }
  async clearPendingMemoryRollback(idempotencyKey) {
    const list = await this.pendingMemoryRollbacks();
    const remaining = list.filter((item) => item.idempotencyKey !== idempotencyKey);
    const path = join(this.root, 'pending-memory-rollbacks.json');
    if (remaining.length === 0) await rm(path, { force: true });
    else await atomicJson(path, remaining);
  }
  async influences() { return readJson(join(this.root, 'influences.json'), []); }
  async saveInfluence(influence) {
    await this.init();
    const list = await this.influences();
    const persona = await this.currentPersona();
    const record = { id: influence.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), persona_revision: persona?.revision ?? null, ...influence };
    list.push(record); await atomicJson(join(this.root, 'influences.json'), list); return record;
  }
  async archiveInfluence(source) {
    const list = await this.influences();
    const index = list.findLastIndex((item) => item.source === source && item.active !== false);
    if (index < 0) throw new Error(`Active influence not found: ${source}`);
    list[index] = { ...list[index], active: false, archived_at: new Date().toISOString() };
    await atomicJson(join(this.root, 'influences.json'), list);
    return list[index];
  }
}
