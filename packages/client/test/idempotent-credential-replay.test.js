import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');
function run(args, { cwd, input = '', env = {}, preload = null }) {
  return new Promise((resolveResult) => {
    const nodeArgs = preload ? ['--import', preload, cli, ...args] : [cli, ...args];
    const child = spawn(process.execPath, nodeArgs, { cwd, env: { ...process.env, OLIMPYX_HOME: join(cwd, '.olimpyx'), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stdout, stderr })); child.stdin.end(input);
  });
}

// Regression coverage for the client half of issue #51: the server now answers a retried
// POST /v1/agents/enroll or POST /v1/sessions with a 2xx "this already happened" response that
// carries no usable credential (agent_token / session_token: null, plus a *_status field
// explaining why). Before this fix the CLI unconditionally tried to save that null value as a
// credential (state.saveCredential / state.saveSession both reject an empty value), which
// crashed the command with a confusing "must be a non-empty single-line value" error -- worse
// than the original bug, since it hid what had actually happened instead of reporting it.
//
// These tests replace global fetch (see preload.mjs below) so no real server is needed.

test('enroll: a replay response (agent_token_status=already_issued) is reported, not saved as a credential, and the existing credential on disk is left untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-replay-'));
  const stateRoot = join(root, '.olimpyx');
  const url = 'https://mock.test';
  const existingCredential = 'previously-issued-agent-token';

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/v1/owners/me/enrollment-tokens')) {
        return new Response(JSON.stringify({ data: { enrollment_token: 'fresh-one-use-code', expires_at: '2099-01-01T00:00:00Z' } }), { headers });
      }
      if (u.includes('/v1/owners/me')) {
        return new Response(JSON.stringify({ data: { owner_id: 'own_1', email: 'owner@example.test', display_name: 'Owner' } }), { headers });
      }
      if (u.includes('/v1/agents/enroll')) {
        return new Response(JSON.stringify({ data: { agent: { agent_id: 'agt_existing', profile_revision: 3 }, agent_token: null, agent_token_status: 'already_issued', message: 'This installation is already enrolled.', created_at: '2026-09-12T00:00:00Z' } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404, headers });
    };
  `);

  assert.equal((await run(['configure', '--server', url], { cwd: root, preload: preloadPath })).status, 0);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(stateRoot, 'credential'), existingCredential, { mode: 0o600 });

  const profile = JSON.stringify({ name: 'Nova', role: 'tester', bio: '', interests: [], capabilities: [] });
  const enroll = await run(['enroll', '--profile', profile], { cwd: root, env: { OLIMPYX_OWNER_TOKEN: 'owner-token' }, preload: preloadPath });

  assert.equal(enroll.status, 0, enroll.stderr);
  const printed = JSON.parse(enroll.stdout);
  assert.equal(printed.already_enrolled, true);
  assert.equal(printed.agent.agent_id, 'agt_existing');
  assert.equal('agent_token' in printed, false, 'a null/absent credential must not be printed as if it were one');

  // The credential already on disk from the original, successful enrollment must survive a
  // replay untouched -- there is no new token to overwrite it with.
  assert.equal(await readFile(join(stateRoot, 'credential'), 'utf8'), existingCredential);
});

test('session begin: a replay response (session_token_status=already_issued) is reported, not saved as a session, and any local session state is left untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-cli-replay-'));
  const stateRoot = join(root, '.olimpyx');
  const url = 'https://mock.test';
  const callerId = 'replay-caller';

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      const headers = { 'content-type': 'application/json' };
      if (u.includes('/v1/sessions') && !u.includes('heartbeat') && !u.includes('end')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_original', session_token: null, session_token_status: 'already_issued', live: true, message: 'A session already exists for this request and is still active.', expires_at: '2099-01-01T00:00:00Z', inbox_cursor: 'c1', bootstrap: {} } }), { headers });
      }
      return new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404, headers });
    };
  `);

  assert.equal((await run(['configure', '--server', url], { cwd: root, preload: preloadPath })).status, 0);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(stateRoot, 'credential'), 'agent-credential', { mode: 0o600 });

  const callerDir = join(stateRoot, 'calls', callerId);
  await mkdir(callerDir, { recursive: true, mode: 0o700 });
  await writeFile(join(callerDir, 'session.json'), `${JSON.stringify({ session_id: 'ses_untouched', expires_at: '2099-01-01T00:00:00Z', caller_id: callerId, caller_deadline: '2099-01-01T00:00:00Z', inbox_cursor: null }, null, 2)}\n`);
  await writeFile(join(callerDir, 'session-credential'), 'sentinel-session-token', { mode: 0o600 });

  const begun = await run(['session', 'begin', '--caller-id', callerId, '--host', 'codex'], { cwd: root, preload: preloadPath });

  assert.equal(begun.status, 0, begun.stderr);
  const printed = JSON.parse(begun.stdout);
  assert.equal(printed.already_started, true);
  assert.equal(printed.live, true);
  assert.equal(printed.session_id, 'ses_original');
  assert.equal('session_token' in printed, false, 'a null/absent credential must not be printed as if it were one');

  // Nothing already saved locally under this caller (from whatever earlier call actually
  // created the session) must be clobbered by a replay that has no token to install.
  assert.equal(JSON.parse(await readFile(join(callerDir, 'session.json'), 'utf8')).session_id, 'ses_untouched');
  assert.equal(await readFile(join(callerDir, 'session-credential'), 'utf8'), 'sentinel-session-token');
});
