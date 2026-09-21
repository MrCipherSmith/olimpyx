import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

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

async function exists(path) {
  try { await readFile(path, 'utf8'); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// The defect: the participant home was `resolve($OLIMPYX_HOME || '.olimpyx')`, rooted at the
// working directory, while the owner home is `$HOME/.olimpyx`. Run a participant command from
// $HOME and both resolved to the same directory, where two incompatible `config.json` schemas
// then overwrote each other. There is no working-directory rule left to collide.
test('a participant command run from $HOME writes nothing into the owner home', async () => {
  const { home, env } = await sandbox('collide');

  const result = await run(['configure', '--server', 'https://example.test'], { cwd: home, env });

  assert.notEqual(result.status, 0, 'no home was selected, so there is nothing to configure');
  assert.equal(
    await exists(join(home, '.olimpyx', 'config.json')),
    false,
    'nothing may be written to the owner home by a participant command'
  );
});

test('an explicit OLIMPYX_HOME pointing at the owner home is refused by name', async () => {
  const { home, env } = await sandbox('explicit');
  const owner = join(home, 'owner');

  const result = await run(['configure', '--server', 'https://example.test'], {
    cwd: home,
    env: { ...env, OLIMPYX_OWNER_HOME: owner, OLIMPYX_HOME: owner }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /owner home/i);
  assert.match(result.stderr, /OLIMPYX_HOME/);
});

test('a relative OLIMPYX_HOME is an error that names the absolute replacement', async () => {
  const { home, env } = await sandbox('relative');

  const result = await run(['configure', '--server', 'https://example.test'], {
    cwd: home,
    env: { ...env, OLIMPYX_OWNER_HOME: join(home, 'owner'), OLIMPYX_HOME: 'state/archi' }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute/i);
  assert.match(result.stderr, new RegExp(join(home, 'state', 'archi').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('OLIMPYX_PARTICIPANT resolves the home the owner config records for that agent', async () => {
  const { home, env } = await sandbox('by-id');
  const owner = join(home, 'owner');
  const agentHome = join(owner, 'agents', 'archi');
  await mkdir(owner, { recursive: true });
  await writeFile(join(owner, 'config.json'), `${JSON.stringify({
    serverUrl: 'https://owner.test',
    agents: [{ id: 'archi', agent_id: 'agt_1', home: agentHome }]
  })}\n`);

  const result = await run(['configure', '--server', 'https://example.test'], {
    cwd: home,
    env: { ...env, OLIMPYX_OWNER_HOME: owner, OLIMPYX_PARTICIPANT: 'archi' }
  });

  assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(await readFile(join(agentHome, 'config.json'), 'utf8'));
  assert.equal(written.serverUrl, 'https://example.test');
});

test('an unknown OLIMPYX_PARTICIPANT names the command that would create it', async () => {
  const { home, env } = await sandbox('unknown-id');
  const owner = join(home, 'owner');
  await mkdir(owner, { recursive: true });
  await writeFile(join(owner, 'config.json'), `${JSON.stringify({ serverUrl: 'https://owner.test', agents: [] })}\n`);

  const result = await run(['configure', '--server', 'https://example.test'], {
    cwd: home,
    env: { ...env, OLIMPYX_OWNER_HOME: owner, OLIMPYX_PARTICIPANT: 'nobody' }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /agent add|olimpyx init/);
});

// The working-directory rule is gone, not deprecated: a home that depends on where a host
// happened to be launched is the defect. Its replacement has to be named where it is refused,
// or the refusal is just a wall.
test('with no home selected, the refusal names both replacements and writes nothing', async () => {
  const { home, env } = await sandbox('no-home');
  const project = join(home, 'project');
  await mkdir(project, { recursive: true });

  const result = await run(['configure', '--server', 'https://example.test'], {
    cwd: project,
    env: { ...env, OLIMPYX_OWNER_HOME: join(home, 'owner') }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OLIMPYX_PARTICIPANT/);
  assert.match(result.stderr, /OLIMPYX_HOME/);
  assert.equal(await exists(join(project, '.olimpyx', 'config.json')), false);
});

// Regression guard: owner-scoped commands never needed a participant home, and refusing the
// collision must not take them down with it.
test('owner commands keep working from $HOME, where the collision exists', async () => {
  const { home, env } = await sandbox('owner-cmd');

  const result = await run(['status'], { cwd: home, env });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).initialized, false);
});
