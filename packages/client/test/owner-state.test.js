import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { LocalState } from '../src/state.js';
import { readOwnerStatus } from '../src/init-apply.js';
import { writeVault } from '../src/vault.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

// Spelled out rather than imported: this is the contract an owner config must carry, and a
// test that reads it from the implementation cannot notice the implementation changing it.
const OWNER_CONFIG_KIND = 'olimpyx.owner-config/1';

function run(args, { cwd, env = {} }) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
    child.stdin.end('');
  });
}

async function sandbox(prefix) {
  const home = await mkdtemp(join(tmpdir(), `olimpyx-${prefix}-`));
  return { home, env: { PATH: process.env.PATH, HOME: home } };
}

async function missing(path) {
  try { await stat(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

// `readVault` called `loadOrCreateKey` before reading, so a command that only wanted to look
// left a 32-byte key behind for a vault that would never exist -- and a later `init` would
// reuse the stale key instead of minting one.
test('an owner command on an uninitialised machine creates no master key', async () => {
  const { home, env } = await sandbox('orphan-key');

  const result = await run(['usage'], { cwd: home, env });

  assert.notEqual(result.status, 0, 'there is no owner credential, so this must fail');
  assert.equal(
    await missing(join(home, '.config', 'olimpyx', 'master.key')),
    true,
    'reading must not leave a key for a vault that does not exist'
  );
});

// `applyInit` overwrites vault.enc and the owner config outright. docs/operations/upgrading.md
// told operators a re-run was a safe no-op; it was not.
test('init on a machine that already has a vault is a no-op', async () => {
  const { home, env } = await sandbox('init-idempotent');
  const owner = join(home, 'owner');
  const vaultEnv = { ...process.env, HOME: home, OLIMPYX_OWNER_HOME: owner };
  await writeVault({ owner: { email: 'owner@example.test', access_token: 'tok' }, agents: {} }, vaultEnv);
  await writeFile(join(owner, 'config.json'), `${JSON.stringify({
    kind: OWNER_CONFIG_KIND,
    serverUrl: 'https://owner.test',
    email: 'owner@example.test',
    agents: [{ id: 'archi', agent_id: 'agt_1', home: join(owner, 'agents', 'archi') }]
  })}\n`);
  const before = await readFile(join(owner, 'vault.enc'), 'utf8');

  const result = await run(['init'], {
    cwd: home,
    env: { ...env, OLIMPYX_OWNER_HOME: owner, OLIMPYX_MASTER_KEY: join(home, '.config', 'olimpyx', 'master.key') }
  });

  assert.equal(result.status, 0, result.stderr);
  const reported = JSON.parse(result.stdout);
  assert.equal(reported.result, 'already_initialized');
  assert.deepEqual(reported.agents, ['archi']);
  assert.equal(await readFile(join(owner, 'vault.enc'), 'utf8'), before, 'the vault must not be rewritten');
});

// A participant config could land on the owner config's path. `readOwnerStatus` parsed it as
// owner config and reported an owner with no email and no agents.
test('a participant config where the owner config belongs is named, not parsed as owner state', async () => {
  const { home } = await sandbox('config-kind');
  const owner = join(home, 'owner');
  const env = { HOME: home, OLIMPYX_OWNER_HOME: owner, OLIMPYX_MASTER_KEY: join(home, 'master.key') };
  await writeVault({ owner: { email: 'owner@example.test' }, agents: {} }, env);
  await writeFile(join(owner, 'config.json'), `${JSON.stringify({
    serverUrl: 'https://owner.test',
    agentId: 'agt_9cb0',
    installationId: 'archi-test-1'
  })}\n`);

  const status = await readOwnerStatus(env);

  assert.equal(status.initialized, true);
  assert.match(status.hint, /participant config/i);
  assert.equal(status.email, undefined, 'no owner fields may be invented from a participant config');
});

test('an owner config carrying the marker still reads as owner state', async () => {
  const { home } = await sandbox('config-kind-ok');
  const owner = join(home, 'owner');
  const env = { HOME: home, OLIMPYX_OWNER_HOME: owner, OLIMPYX_MASTER_KEY: join(home, 'master.key') };
  await writeVault({ owner: { email: 'owner@example.test' }, agents: {} }, env);
  await writeFile(join(owner, 'config.json'), `${JSON.stringify({
    kind: OWNER_CONFIG_KIND,
    serverUrl: 'https://owner.test',
    email: 'owner@example.test',
    agents: []
  })}\n`);

  const status = await readOwnerStatus(env);

  assert.equal(status.email, 'owner@example.test');
});

// `callerDir` created these on demand and nothing removed them; twelve accumulated on one host
// in an afternoon, each holding a dead session-credential.
test('stale caller directories are collected, live and unacknowledged ones are kept', async () => {
  const { home } = await sandbox('prune');
  const state = new LocalState(join(home, 'participant'));
  const day = 86_400_000;

  const stale = await state.callerDir('caller-stale');
  await writeFile(join(stale, 'session.json'), `${JSON.stringify({
    session_id: 'ses_old', caller_id: 'caller-stale', caller_deadline: new Date(Date.now() - 3 * day).toISOString()
  })}\n`);
  await writeFile(join(stale, 'session-credential'), 'dead-token');

  const fresh = await state.callerDir('caller-fresh');
  await writeFile(join(fresh, 'session.json'), `${JSON.stringify({
    session_id: 'ses_new', caller_id: 'caller-fresh', caller_deadline: new Date(Date.now() + 60_000).toISOString()
  })}\n`);

  const owed = await state.callerDir('caller-owed');
  await writeFile(join(owed, 'session.json'), `${JSON.stringify({
    session_id: 'ses_owed', caller_id: 'caller-owed', caller_deadline: new Date(Date.now() - 3 * day).toISOString()
  })}\n`);
  await writeFile(join(owed, 'pending-mutations.json'), `${JSON.stringify({ abc: { key: 'idem-1', method: 'POST', path: '/v1/messages' } })}\n`);

  const empty = join(home, 'participant', 'calls', 'caller-empty');
  await mkdir(empty, { recursive: true });

  const removed = await state.pruneCallers();

  assert.deepEqual(removed.sort(), ['caller-empty', 'caller-stale']);
  assert.equal(await missing(stale), true);
  assert.equal(await missing(fresh), false, 'a live caller lease is not garbage');
  assert.equal(await missing(owed), false, 'an unacknowledged mutation key is the only guard against a duplicate send');
});
