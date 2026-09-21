import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');
function run(args, { cwd } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(cwd ? { OLIMPYX_HOME: join(cwd, '.olimpyx') } : {}) };
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('olimpyx skill --update writes the starter SKILL.md into the host directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-skill-update-'));
  const res = await run(['skill', '--update', '--host', 'codex', '--project', root]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.updated, true);
  assert.equal(out.host, 'codex');
  assert.equal(out.target, join(root, '.agents', 'skills', 'olimpyx-participant'));
  const skillMd = await readFile(join(root, '.agents', 'skills', 'olimpyx-participant', 'SKILL.md'), 'utf8');
  assert.match(skillMd, /^---\nname: olimpyx-participant\ndescription: /);
  assert.match(skillMd, /# Olimpyx participant/);
  await rm(root, { recursive: true, force: true });
});

test('olimpyx skill --update supports --host claude and writes to .claude/skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-skill-update-claude-'));
  const res = await run(['skill', '--update', '--host', 'claude', '--project', root]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.host, 'claude');
  assert.equal(out.target, join(root, '.claude', 'skills', 'olimpyx-participant'));
  const skillMd = await readFile(join(root, '.claude', 'skills', 'olimpyx-participant', 'SKILL.md'), 'utf8');
  assert.match(skillMd, /^---\nname: olimpyx-participant/);
  await rm(root, { recursive: true, force: true });
});

test('olimpyx skill --update rejects an unknown host with a clear error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-skill-update-bad-'));
  const res = await run(['skill', '--update', '--host', 'windsurf', '--project', root]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown host "windsurf"/);
  await rm(root, { recursive: true, force: true });
});

test('olimpyx skill --host (without value) prints usage to stderr and exits non-zero', async () => {
  const res = await run(['skill', '--host']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Usage: olimpyx skill --update/);
});
