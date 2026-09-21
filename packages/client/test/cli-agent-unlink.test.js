import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

function run(args, { cwd, input = '', env = {}, preload = null }) {
  return new Promise((resolveResult) => {
    const nodeArgs = preload ? ['--import', preload, cli, ...args] : [cli, ...args];
    const child = spawn(process.execPath, nodeArgs, {
      // OLIMPYX_OWNER_HOME points at the seeded owner home (cwd/.olimpyx); the participant
      // home is unset so `resolveParticipantHome` short-circuits before reading any state
      // file. `OLIMPYX_OWNER_TOKEN` makes `requireOwnerClient` skip the participant-state
      // probing entirely, which is the bit the unlink/list commands actually need.
      cwd,
      env: {
        ...process.env,
        OLIMPYX_OWNER_HOME: join(cwd, '.olimpyx'),
        OLIMPYX_MASTER_KEY: join(cwd, '.config', 'olimpyx', 'master.key'),
        OLIMPYX_OWNER_TOKEN: 'owner-token-mock',
        ...env
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

// Seed an owner config with one agent, mimicking the post-init layout.
// The CLI's unlink handler reads ~/.olimpyx/config.json and removes the
// matching entry -- this fixture gives it something to remove.
async function seedOwner(root, { agents }) {
  const ownerHome = join(root, '.olimpyx');
  await mkdir(ownerHome, { recursive: true, mode: 0o700 });
  await mkdir(join(ownerHome, 'agents'), { recursive: true, mode: 0o700 });
  const config = {
    serverUrl: 'https://mock.test',
    email: 'owner@example.test',
    displayName: 'Test Owner',
    skillScope: 'global',
    projectPath: null,
    hosts: ['claude', 'codex'],
    agents
  };
  await writeFile(join(ownerHome, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // Real home dir for each agent -- otherwise rm -rf reports "no such file
  // or directory" but the test still passes (because we treat that as a
  // soft warning); we want the test to also exercise the rm success path.
  for (const a of agents) {
    await mkdir(a.home, { recursive: true, mode: 0o700 });
    await writeFile(join(a.home, '.sentinel'), `${randomUUID()}\n`, { mode: 0o600 });
  }
  // Vault + master key: required because `requireOwnerClient` reads them
  // first. We write them but never use them (the preload short-circuits
  // the network); the files just need to exist and to look owned (0600).
  const configDir = join(root, '.config', 'olimpyx');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, 'master.key'), '0'.repeat(32), { mode: 0o600 });
  await writeFile(join(ownerHome, 'owner-credential'), 'owner-token-mock', { mode: 0o600 });
  return ownerHome;
}

test('agent unlink resolves the human id to the server id, deletes the home, and updates config.json', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-unlink-cli-'));
  const agentId = `agt_${randomUUID().replaceAll('-', '')}`;
  const agentHome = join(root, '.olimpyx', 'agents', 'helios');
  await seedOwner(root, {
    agents: [
      { id: 'helios', agent_id: agentId, home: agentHome },
      { id: 'prometheus', agent_id: `agt_${randomUUID().replaceAll('-', '')}`, home: join(root, '.olimpyx', 'agents', 'prometheus') }
    ]
  });

  // Preload mocks the server: POST /v1/owners/me/agents/.../unlink returns
  // 200; reads of ~/.olimpyx/config.json and the agent home still go through
  // the real filesystem because the preload only stubs globalThis.fetch.
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (!u.includes('/v1/owners/me/agents/')) {
        return new Response('not found', { status: 404 });
      }
      // Any unlink call: return a canned success with the agent_id from the path.
      const m = u.match(/\\/agents\\/([^/]+)\\/unlink/);
      return new Response(JSON.stringify({
        data: { agent_id: m ? m[1] : 'unknown', unlinked_at: new Date().toISOString(), unlinked_reason: opts.body ? JSON.parse(opts.body).reason ?? null : null }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `);

  const result = await run(['agent', 'unlink', 'helios', '--reason', 'housekeeping'], {
    cwd: root, preload: preloadPath
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const body = JSON.parse(result.stdout);
  assert.equal(body.server.data.agent_id, agentId);
  assert.equal(body.local.removed.id, 'helios');
  assert.equal(body.local.removed.agent_id, agentId);
  assert.equal(body.home.removed, true);

  // Side effects: helios is gone from config, prometheus stays.
  const cfg = JSON.parse(await readFile(join(root, '.olimpyx', 'config.json'), 'utf8'));
  assert.equal(cfg.agents.find((a) => a.id === 'helios'), undefined, 'helios removed from config');
  assert.ok(cfg.agents.find((a) => a.id === 'prometheus'), 'prometheus untouched');
  // The home directory is gone.
  await assert.rejects(readFile(join(agentHome, '.sentinel')), /ENOENT/, 'agent home removed');

  await rm(root, { recursive: true, force: true });
});

test('agent unlink accepts the server agent_id directly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-unlink-cli-id-'));
  const agentId = `agt_${randomUUID().replaceAll('-', '')}`;
  const agentHome = join(root, '.olimpyx', 'agents', 'helios');
  await seedOwner(root, {
    agents: [{ id: 'helios', agent_id: agentId, home: agentHome }]
  });

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { agent_id: '${agentId}', unlinked_at: new Date().toISOString(), unlinked_reason: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
  `);

  const result = await run(['agent', 'unlink', agentId], { cwd: root, preload: preloadPath });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const body = JSON.parse(result.stdout);
  assert.equal(body.local.removed.id, 'helios');

  await rm(root, { recursive: true, force: true });
});

test('agent unlink fails closed if the server rejects and the local home still exists', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-unlink-cli-fail-'));
  const agentId = `agt_${randomUUID().replaceAll('-', '')}`;
  const agentHome = join(root, '.olimpyx', 'agents', 'helios');
  await seedOwner(root, {
    agents: [{ id: 'helios', agent_id: agentId, home: agentHome }]
  });

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'forbidden', message: 'nope' } }), { status: 403, headers: { 'content-type': 'application/json' } });
  `);

  const result = await run(['agent', 'unlink', 'helios'], { cwd: root, preload: preloadPath });
  assert.equal(result.status, 1);
  // Server rejected -> local must not be touched. The config still lists helios,
  // and the home directory still exists.
  const cfg = JSON.parse(await readFile(join(root, '.olimpyx', 'config.json'), 'utf8'));
  assert.ok(cfg.agents.find((a) => a.id === 'helios'), 'helios still in config after server failure');
  await assert.doesNotReject(readFile(join(agentHome, '.sentinel')), 'agent home still present after server failure');

  await rm(root, { recursive: true, force: true });
});

test('agent unlink without a server agent_id in config errors cleanly', async (t) => {
  // The home dir doesn't exist; unlink still proceeds with the human id passed
  // through to the server. Server rejects (404) -> CLI exits with the server's
  // 4xx and config stays untouched (we never reached the rm step).
  const root = await mkdtemp(join(tmpdir(), 'agent-unlink-cli-404-'));
  await seedOwner(root, { agents: [] });
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'agent not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
  `);

  const result = await run(['agent', 'unlink', 'helios'], { cwd: root, preload: preloadPath });
  assert.equal(result.status, 1);

  await rm(root, { recursive: true, force: true });
});

test('agent list --json prints raw server payload', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-list-cli-'));
  await seedOwner(root, { agents: [] });
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (!u.startsWith('https://mock.test/v1/owners/me/agents')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({
        data: [
          { agent_id: 'agt_alpha', name: 'Alpha', restricted: false, revoked: false, unlinked: false },
          { agent_id: 'agt_beta',  name: 'Beta',  restricted: true,  revoked: false, unlinked: true, unlinked_at: '2026-09-21T00:00:00Z', unlinked_reason: 'housekeeping' }
        ],
        page: { next_cursor: null }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `);

  const result = await run(['agent', 'list', '--json'], { cwd: root, preload: preloadPath });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const body = JSON.parse(result.stdout);
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].agent_id, 'agt_alpha');

  await rm(root, { recursive: true, force: true });
});

test('agent list compact output shows revoked/unlinked/restricted in the third column', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-list-cli-compact-'));
  await seedOwner(root, { agents: [] });
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [
        { agent_id: 'agt_alpha', name: 'Alpha', restricted: false, revoked: false, unlinked: false },
        { agent_id: 'agt_beta',  name: 'Beta',  restricted: true,  revoked: true,  unlinked: false },
        { agent_id: 'agt_gamma', name: 'Gamma', restricted: false, revoked: false, unlinked: true }
      ],
      page: { next_cursor: null }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  `);

  const result = await run(['agent', 'list'], { cwd: root, preload: preloadPath });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Alpha\s+agt_alpha\s+active$/);
  assert.match(lines[1], /^Beta\s+agt_beta\s+restricted,revoked$/);
  assert.match(lines[2], /^Gamma\s+agt_gamma\s+unlinked$/);

  await rm(root, { recursive: true, force: true });
});
