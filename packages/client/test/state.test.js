import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalState } from '../src/state.js';

test('stores agent credential separately with owner-only permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-'));
  const state = new LocalState(root);
  await state.saveConfig({ serverUrl: 'https://example.test' });
  await state.saveCredential('agent-secret');
  assert.equal((await stat(join(root, 'credential'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(root, 'credential'), 'utf8'), 'agent-secret');
  assert.equal(JSON.stringify(await state.loadConfig()).includes('agent-secret'), false);
});

test('repairs permissions when replacing an existing credential file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-'));
  const state = new LocalState(root); await state.init();
  const path = join(root, 'credential');
  await writeFile(path, 'old'); await chmod(path, 0o644);
  await state.saveCredential('replacement-secret');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('saves persona revisions, restores one, and archives inactive influence only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-'));
  const state = new LocalState(root);
  const first = await state.savePersona({ name: 'Nova', interests: ['testing'] }, 'initial');
  await state.savePersona({ name: 'Nova', interests: ['testing', 'security'] }, 'learned');
  await state.saveInfluence({ source: 'room-after-first', summary: 'Prefer terse replies', active: true });
  const restored = await state.rollbackPersona(first.revision);
  assert.deepEqual(restored.persona.interests, ['testing']);
  assert.equal((await state.influences())[0].active, false);
  await state.saveInfluence({ source: 'room-1', summary: 'Prefer citations', active: true });
  const archived = await state.archiveInfluence('room-1');
  assert.equal(archived.active, false);
  assert.deepEqual(restored.persona.interests, ['testing']);
});

test('rejects persona revision path traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-'));
  const state = new LocalState(root);
  await assert.rejects(state.rollbackPersona('../../config'), /Invalid persona revision/);
});

test('stores a temporary session token privately and requires its active caller to renew', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-')); const state = new LocalState(root);
  await state.saveSession({ session_id: 'ses_1', session_token: 'temporary-token', expires_at: '2099-01-01T00:00:00Z', inbox_cursor: 'c1' }, 'caller-a');
  assert.equal((await stat(join(root, 'session-credential'))).mode & 0o777, 0o600);
  assert.equal((await state.loadSession()).token, 'temporary-token');
  await assert.rejects(state.renewSession('caller-b'), /does not own/);
  const renewed = await state.renewSession('caller-a', { inbox_cursor: 'c2' });
  assert.equal(renewed.inbox_cursor, 'c2');
});

test('rollback preserves influences from the target and earlier revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-')); const state = new LocalState(root);
  await state.savePersona({ name: 'Nova', phase: 1 }); await state.saveInfluence({ source: 'early', active: true });
  const middle = await state.savePersona({ name: 'Nova', phase: 2 }); await state.saveInfluence({ source: 'middle', active: true });
  await state.savePersona({ name: 'Nova', phase: 3 }); await state.saveInfluence({ source: 'late', active: true });
  await state.rollbackPersona(middle.revision);
  const bySource = Object.fromEntries((await state.influences()).map((item) => [item.source, item.active]));
  assert.deepEqual(bySource, { early: true, middle: true, late: false });
});
