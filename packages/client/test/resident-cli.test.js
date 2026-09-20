import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runResidentCli } from '../src/resident/cli.mjs';
import { ResidentStore } from '../src/resident/resident-store.mjs';
import { LocalState } from '../src/state.js';

test('resident CLI starts, observes, records memory and resumes using one host session', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'resident-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const state = new LocalState(home);
  await state.saveConfig({ agentId: 'agt_archi', installationId: 'installation-test', serverUrl: 'https://mock.test' });
  await state.saveCredential('private-agent-value');
  let sessions = 0;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    let data = {};
    if (path === '/v1/sessions') { sessions++; data = { session_id: 'ses_test', session_token: 'private-session-value' }; }
    else if (path === '/v1/city-guide') data = { revision: 'test', body: 'City guide' };
    else if (path === '/v1/inbox/events') data = [];
    else assert.match(path, /heartbeat|end/);
    return new Response(JSON.stringify({ data, page: { next_cursor: null } }), { status: 200 });
  };
  const run = async (command, decision) => {
    let output = '';
    await runResidentCli([command, '--home', home, ...(decision ? ['--decision-stdin'] : [])], { fetchImpl, stdout: { write: (s) => { output += s; } }, stdin: Readable.from(decision ? [JSON.stringify(decision)] : []) });
    assert.ok(!output.includes('private-agent-value'));
    assert.ok(!output.includes('private-session-value'));
    return JSON.parse(output);
  };
  const start = await run('start');
  await run('observe');
  await run('act', { actionId: 'first-note', plan: 'note', payload: { title: 'Memory', body: 'Keep facts small.' }, compress: 'My first memory.', nextStep: 'Recover it.' });
  const restored = await run('start');
  assert.equal(restored.experimentId, start.experimentId);
  assert.equal(restored.memory.summary, 'My first memory.');
  assert.equal(sessions, 1);
  assert.equal((await run('end')).stopReason, 'owner_ended');
});

test('malformed stdin is recorded without raw input', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'resident-invalid-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previousExitCode = process.exitCode;
  try {
    let output = '';
    await runResidentCli(['act', '--home', home, '--decision-stdin'], { stdin: Readable.from(['private malformed input']), stdout: { write: (s) => { output += s; } } });
    assert.equal(JSON.parse(output).ok, false);
    const recent = await new ResidentStore(home).readRecent();
    assert.equal(recent[0].type, 'invalid_input');
    assert.ok(!JSON.stringify(recent).includes('private malformed input'));
  } finally { process.exitCode = previousExitCode; }
});
