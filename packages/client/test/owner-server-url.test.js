import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { writeVault } from '../src/vault.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

function run(args, { cwd, env, preload }) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, ['--import', preload, cli, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
    child.stdin.end('');
  });
}

/** A stub that answers /v1/limits by reporting which origin the CLI actually called. */
async function echoPreload(root) {
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      return new Response(JSON.stringify({ data: { calledOrigin: u.origin, path: u.pathname } }),
        { headers: { 'content-type': 'application/json' } });
    };
  `);
  return preloadPath;
}

async function ownerInstall({ ownerServer }) {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-ownerurl-'));
  const ownerHome = join(root, 'owner-home');
  const keyPath = join(root, 'master.key');
  await mkdir(ownerHome, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    OLIMPYX_OWNER_HOME: ownerHome,
    OLIMPYX_MASTER_KEY: keyPath,
    OLIMPYX_LANG: 'en'
  };
  await writeFile(join(ownerHome, 'config.json'), JSON.stringify({ serverUrl: ownerServer, email: 'owner@example.test' }));
  await writeVault({ owner: { access_token: 'owner-token', email: 'owner@example.test' }, agents: {} }, env);
  return { root, env, preload: await echoPreload(root) };
}

// The defect this pins down: owner-scoped commands used to read the server URL from
// `state`, which is rooted at the WORKING DIRECTORY, while `init` writes the owner config
// to the owner home. Run from anywhere else, `limits` therefore either died inside the
// client constructor on an undefined URL, or -- when the directory happened to hold a
// project configured against another server -- sent the owner's real token there and got
// back 401 "Invalid or expired credential", a message that blames the token for a path bug.
test('owner commands find the server in the owner home, whatever directory they run from', async () => {
  const { root, env, preload } = await ownerInstall({ ownerServer: 'https://owner-home.test' });
  const elsewhere = await mkdtemp(join(tmpdir(), 'olimpyx-elsewhere-'));

  for (const cwd of [root, elsewhere]) {
    const result = await run(['limits'], { cwd, env, preload });
    assert.equal(result.status, 0, `limits failed from ${cwd}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).data.calledOrigin, 'https://owner-home.test');
    assert.equal(JSON.parse(result.stdout).data.path, '/v1/limits');
  }
});

test('a project-local config still takes precedence over the owner home', async () => {
  const { root, env, preload } = await ownerInstall({ ownerServer: 'https://owner-home.test' });
  const project = join(root, 'project');
  await mkdir(join(project, '.olimpyx'), { recursive: true });
  await writeFile(join(project, '.olimpyx', 'config.json'), JSON.stringify({ serverUrl: 'https://project.test' }));

  const result = await run(['limits'], { cwd: project, env, preload });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.calledOrigin, 'https://project.test');
});

test('with nothing configured anywhere, the error names the fix instead of crashing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-unconfigured-'));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    OLIMPYX_OWNER_HOME: join(root, 'owner-home'),
    OLIMPYX_MASTER_KEY: join(root, 'master.key'),
    OLIMPYX_OWNER_TOKEN: 'owner-token',
    OLIMPYX_LANG: 'en'
  };
  const result = await run(['limits'], { cwd: root, env, preload: await echoPreload(root) });
  assert.equal(result.status, 1);
  // Not "Cannot read properties of undefined (reading 'replace')", which is what the old
  // path produced and which tells the reader nothing about what to do.
  assert.match(result.stderr, /Not configured/);
  assert.doesNotMatch(result.stderr, /undefined/);
});
