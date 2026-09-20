import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');
function run(args, { cwd, input = '', env = {}, preload = null }) {
  return new Promise((resolveResult) => {
    const nodeArgs = preload ? ['--import', preload, cli, ...args] : [cli, ...args];
    const child = spawn(process.execPath, nodeArgs, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function makeTmp() {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-init-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  return { root, stateDir };
}

test('init: first-time setup creates credential, owner token, and saves config', async (t) => {
  const { root, stateDir } = await makeTmp();
  const preload = join(root, 'preload.mjs');
  await writeFile(preload, `
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/v1/owners/me')) {
        return new Response(JSON.stringify({ data: { owner_id: 'own_1', email: 'me@example.test', display_name: 'Me' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.endsWith('/v1/owners/login')) {
        return new Response(JSON.stringify({ data: { owner: { owner_id: 'own_1' }, access_token: 'owner-token-1', expires_at: '2099-01-01' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.endsWith('/v1/owners/me/enrollment-tokens')) {
        return new Response(JSON.stringify({ data: { enrollment_token: 'tok_1', expires_at: '2099-01-01' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.endsWith('/v1/agents/enroll')) {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({ data: { agent: { agent_id: 'agt_new_1', profile_revision: 1 }, agent_token: 'agent-token-1', created_at: '2026-09-20T12:00:00Z' } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('not stubbed', { status: 404 });
    };
  `);
  const profile = join(root, 'profile.json');
  await writeFile(profile, JSON.stringify({ name: 'Init', role: 'test', bio: '', interests: [], capabilities: [] }));
  const res = await run(['init', '--server', 'https://mock.test', '--email', 'me@example.test', '--password-stdin', '--profile', '@' + profile], { cwd: root, input: 'pw', preload });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.result, 'initialized');
  assert.equal(out.changed.serverUrl, true);
  assert.equal(out.changed.ownerCredential, true);
  assert.equal(out.changed.agentCredential, true);
  const owner = (await readFile(join(stateDir, 'owner-credential'), 'utf8')).trim();
  const cred = (await readFile(join(stateDir, 'credential'), 'utf8')).trim();
  assert.equal(owner, 'owner-token-1');
  assert.equal(cred, 'agent-token-1');
  const cfg = JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8'));
  assert.equal(cfg.serverUrl, 'https://mock.test');
  assert.equal(cfg.agentId, 'agt_new_1');
  assert.equal(cfg.ownerId, 'own_1');
  assert.ok(cfg.installationId);
  await rm(root, { recursive: true, force: true });
});

test('init: re-run on a healthy install is a no-op (no new agent, no overwrites)', async (t) => {
  const { root, stateDir } = await makeTmp();
  // Seed an existing install with a valid credential.
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test', agentId: 'agt_old', ownerId: 'own_1', installationId: 'inst-1', profileRevision: 1 }));
  await writeFile(join(stateDir, 'owner-credential'), 'cached-owner\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'credential'), 'cached-agent\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'persona.json'), JSON.stringify({ revision: 'p-1', ordinal: 1, persona: { name: 'Init' } }));

  let enrollCalled = false;
  let tokenIssued = false;
  const preload = join(root, 'preload.mjs');
  await writeFile(preload, `
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/v1/owners/me')) {
        return new Response(JSON.stringify({ data: { owner_id: 'own_1', email: 'me@example.test', display_name: 'Me' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.endsWith('/v1/agents/agt_old')) {
        return new Response(JSON.stringify({ data: { agent_id: 'agt_old', name: 'Init', presence: 'online' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.endsWith('/v1/owners/me/enrollment-tokens')) { tokenIssued = true; return new Response('{}', { status: 500 }); }
      if (u.endsWith('/v1/agents/enroll')) { enrollCalled = true; return new Response('{}', { status: 500 }); }
      return new Response('not stubbed', { status: 404 });
    };
  `);
  const res = await run(['init'], { cwd: root, preload });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.result, 'already_initialized');
  assert.equal(enrollCalled, false, 'init must NOT re-enroll when an existing agent is healthy');
  assert.equal(tokenIssued, false, 'init must NOT re-issue an enrollment token in the no-op path');
  assert.equal(out.changed.agentCredential, false);
  const cred = (await readFile(join(stateDir, 'credential'), 'utf8')).trim();
  assert.equal(cred, 'cached-agent');
  await rm(root, { recursive: true, force: true });
});

test('init: --new-agent rotates installationId and creates a fresh agent, leaving the old row on the server', async (t) => {
  const { root, stateDir } = await makeTmp();
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test', agentId: 'agt_old', ownerId: 'own_1', installationId: 'inst-1', profileRevision: 1 }));
  await writeFile(join(stateDir, 'owner-credential'), 'cached-owner\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'credential'), 'cached-agent\n', { mode: 0o600 });

  let observedInstallationId = null;
  const preload = join(root, 'preload.mjs');
  const observedFile = join(root, 'observed.json');
  await writeFile(preload, `
    import { writeFileSync } from 'node:fs';
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/v1/owners/me')) return new Response(JSON.stringify({ data: { owner_id: 'own_1' } }), { headers: { 'content-type': 'application/json' } });
      if (u.endsWith('/v1/agents/agt_old')) return new Response(JSON.stringify({ data: { agent_id: 'agt_old', name: 'Init' } }), { headers: { 'content-type': 'application/json' } });
      if (u.endsWith('/v1/owners/me/enrollment-tokens')) return new Response(JSON.stringify({ data: { enrollment_token: 'tok_n' } }), { headers: { 'content-type': 'application/json' } });
      if (u.endsWith('/v1/agents/enroll')) {
        writeFileSync(${JSON.stringify(observedFile)}, JSON.stringify({ installation_id: JSON.parse(init.body).installation_id }));
        return new Response(JSON.stringify({ data: { agent: { agent_id: 'agt_new_2', profile_revision: 1 }, agent_token: 'new-agent-token' } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('not stubbed', { status: 404 });
    };
  `);
  const profile = join(root, 'profile.json');
  await writeFile(profile, JSON.stringify({ name: 'Init2', role: 'test' }));
  const res = await run(['init', '--new-agent', '--profile', '@' + profile], { cwd: root, preload });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.result, 'new_agent_created');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /Existing agent/);
  const cred = (await readFile(join(stateDir, 'credential'), 'utf8')).trim();
  assert.equal(cred, 'new-agent-token');
  const cfg = JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8'));
  assert.equal(cfg.agentId, 'agt_new_2');
  assert.notEqual(cfg.installationId, 'inst-1');
  // The server-side install request must have used a different installationId.
  const observed = JSON.parse(await readFile(observedFile, 'utf8'));
  assert.notEqual(observed.installation_id, 'inst-1');
  await rm(root, { recursive: true, force: true });
});

test('init: when enroll returns 409 agent_already_enrolled, init adopts the existing row instead of failing', async (t) => {
  const { root, stateDir } = await makeTmp();
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test', agentId: 'stale-agent-id', installationId: 'inst-2', profileRevision: 0 }));
  await writeFile(join(stateDir, 'owner-credential'), 'cached-owner\n', { mode: 0o600 });
  // Stale credential: server will reject agent lookup; enroll will be tried
  // and return 409; init must adopt the existing row.
  await writeFile(join(stateDir, 'credential'), 'old-token\n', { mode: 0o600 });

  const preload = join(root, 'preload.mjs');
  await writeFile(preload, `
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/v1/owners/me')) return new Response(JSON.stringify({ data: { owner_id: 'own_1' } }), { headers: { 'content-type': 'application/json' } });
      if (u.endsWith('/v1/agents/stale-agent-id')) return new Response('forbidden', { status: 403 });
      if (u.endsWith('/v1/owners/me/enrollment-tokens')) return new Response(JSON.stringify({ data: { enrollment_token: 'tok_409' } }), { headers: { 'content-type': 'application/json' } });
      if (u.endsWith('/v1/agents/enroll')) {
        return new Response(JSON.stringify({ error: { code: 'agent_already_enrolled', details: { agent_id: 'agt_409', profile_revision: 5 } } }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not stubbed', { status: 404 });
    };
  `);
  const profile = join(root, 'profile.json');
  await writeFile(profile, JSON.stringify({ name: 'Init', role: 'test' }));
  const res = await run(['init', '--profile', '@' + profile], { cwd: root, preload });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.result, 'already_initialized');
  assert.equal(out.steps[2].action, 'adopted_existing');
  assert.equal(out.steps[2].agent_id, 'agt_409');
  const cfg = JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8'));
  assert.equal(cfg.agentId, 'agt_409');
  assert.equal(cfg.profileRevision, 5);
  await rm(root, { recursive: true, force: true });
});

test('init: refuses to run without --server when no saved URL is present', async (t) => {
  const { root, stateDir } = await makeTmp();
  const res = await run(['init'], { cwd: root });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /No server configured/);
  await rm(root, { recursive: true, force: true });
});
