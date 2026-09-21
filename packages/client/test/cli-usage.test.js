import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

function run(args, { cwd, env = {} } = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
  });
}

test('--version prints the package version from package.json', async () => {
  const r = await run(['--version'], { cwd: '/tmp' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^olimpyx \d+\.\d+\.\d+\n$/);
  // Make sure the binary's version matches package.json -- this guards against
  // the version being hard-coded somewhere instead of read at runtime.
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(
    join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'
  ));
  assert.match(r.stdout, new RegExp(`^olimpyx ${pkg.version.replace(/\./g, '\\.')}\\n$`));
});

test('-v is the same as --version', async () => {
  const r = await run(['-v'], { cwd: '/tmp' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^olimpyx \d+\.\d+\.\d+\n$/);
});

test('no args prints the pretty multi-line usage, not a one-liner', async () => {
  const r = await run([], { cwd: '/tmp' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^olimpyx \d+\.\d+\.\d+\b/m);
  // The old single-line output is gone -- those long command-list lines are
  // the symptom we removed. None of them should appear anymore.
  assert.equal(r.stdout.includes('Usage: olimpyx init|status|skill|resident|configure|owner-login|'), false);
  // And the grouped headers we added must be present.
  assert.match(r.stdout, /OWNER SETUP/);
  assert.match(r.stdout, /AGENT SETUP/);
  assert.match(r.stdout, /SESSIONS/);
  assert.match(r.stdout, /COMMUNICATION/);
  assert.match(r.stdout, /KNOWLEDGE & MEMORY/);
  assert.match(r.stdout, /GOVERNANCE/);
  assert.match(r.stdout, /OPERATIONS/);
});

test('-h and --help print the same usage as no args', async () => {
  const h = await run(['-h'], { cwd: '/tmp' });
  const help = await run(['--help'], { cwd: '/tmp' });
  assert.equal(h.status, 0);
  assert.equal(help.status, 0);
  // The header line ("olimpyx X.Y.Z -- ...") is the easiest unique fingerprint.
  const fingerprint = /^olimpyx \d+\.\d+\.\d+\b/m;
  assert.match(h.stdout, fingerprint);
  assert.match(help.stdout, fingerprint);
});

test('usage lists every command in the surface', async () => {
  const r = await run([], { cwd: '/tmp' });
  // Order is presentation-only in COMMANDS, but every name should appear,
  // matched on the line where it leads its group (not as a substring of
  // another command's summary or another word).
  const required = [
    'init', 'configure', 'owner-login', 'status', 'skill',
    'enroll', 'resident',
    'session', 'bootstrap', 'activity', 'request',
    'rooms', 'room', 'inbox', 'message', 'threads', 'read', 'wait', 'listen',
    'knowledge', 'persona', 'memory', 'influence',
    'forum', 'incidents', 'appeal', 'report', 'subscribe', 'recommendations',
    'agent', 'usage', 'limits', 'budget', 'task'
  ];
  for (const name of required) {
    const re = new RegExp(`^\\s{2}${name}\\s{2,}\\S`);
    const matched = r.stdout.split('\n').some((line) => re.test(line));
    assert.ok(matched, `missing command: ${name}`);
  }
});

test('column width adapts to the longest command name', async () => {
  const r = await run([], { cwd: '/tmp' });
  // `recommendations` is the widest (15 chars). The summary that follows its
  // padded name must start at the SAME column as the summary after `forum`
  // (4 chars). If the column is fixed and short, `recommendations` slides
  // into its own summary and the layout breaks.
  const lines = r.stdout.split('\n');
  const forumLine = lines.find((l) => /^\s{2}forum\s+\S/.test(l));
  const recLine = lines.find((l) => /^\s{2}recommendations\s+\S/.test(l));
  assert.ok(forumLine, 'forum summary line missing');
  assert.ok(recLine, 'recommendations summary line missing');
  // First summary word positions must agree across commands.
  const forumCol = forumLine.indexOf('list', forumLine.indexOf('forum'));
  const recCol = recLine.indexOf('Manage', recLine.indexOf('recommendations'));
  assert.equal(forumCol, recCol, 'summary column mismatch -- padding is not aligned');
});

test('help <cmd> prints per-command usage for known commands', async () => {
  const room = await run(['help', 'room'], { cwd: '/tmp' });
  assert.equal(room.status, 0);
  assert.match(room.stdout, /olimpyx room new/);
  assert.match(room.stdout, /olimpyx room join/);
  assert.match(room.stdout, /olimpyx room leave/);
  assert.match(room.stdout, /olimpyx room goal/);

  const session = await run(['help', 'session'], { cwd: '/tmp' });
  assert.equal(session.status, 0);
  assert.match(session.stdout, /olimpyx session begin/);
  assert.match(session.stdout, /olimpyx session prune/);

  const enroll = await run(['help', 'enroll'], { cwd: '/tmp' });
  assert.equal(enroll.status, 0);
  assert.match(enroll.stdout, /--profile JSON\|@file/);
});

test('help <unknown> exits 1 and points at --help', async () => {
  const r = await run(['help', 'no-such-command'], { cwd: '/tmp' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No help for unknown command: no-such-command/);
  assert.match(r.stderr, /Run 'olimpyx --help'/);
});

test('plain `help` prints full usage (same as no args)', async () => {
  const r = await run(['help'], { cwd: '/tmp' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^olimpyx \d+\.\d+\.\d+\b/m);
  assert.match(r.stdout, /OWNER SETUP/);
});

test('unknown command exits 1 and points at --help', async () => {
  const r = await run(['no-such-command'], { cwd: '/tmp' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command/i);
  assert.match(r.stderr, /Run 'olimpyx --help'/);
});

test('usage is not dumped on the wire; errors stay on stderr', async () => {
  // --version -> stdout only, stderr empty
  const v = await run(['--version'], { cwd: '/tmp' });
  assert.equal(v.stderr, '');

  // help unknown -> stderr only, stdout empty
  const h = await run(['help', 'no-such'], { cwd: '/tmp' });
  assert.equal(h.stdout, '');
  assert.match(h.stderr, /No help/);
});
