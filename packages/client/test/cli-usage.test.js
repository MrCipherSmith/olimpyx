import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { COMMAND_HELP } from '../src/usage.js';

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
  const recCol = recLine.indexOf('List', recLine.indexOf('recommendations'));
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

// ---------------------------------------------------------------------------
// Issue #63: the printed help for `subscribe` and `recommendations` once
// documented an interface (`add`/`remove`/`set`/`enable`/`disable`
// subcommands, `--room`/`--inbox`/positional SOURCE) that cli.js's dispatcher
// never implemented. These two tests derive "what the help promises" from
// COMMAND_HELP (usage.js) and "what the code actually accepts" from the
// dispatcher's own source text for that command, then compare the two --
// mechanically, from the source of truth on each side, rather than by
// re-typing an expected string that would just encode this fix and drift
// again the next time either file changes.
// ---------------------------------------------------------------------------

const cliSource = readFileSync(cli, 'utf8');

// Slices out the `if (command === '<name>') { ... }` dispatch block for one
// command, by brace-counting from the opening brace. Throws if the marker
// isn't found, so a future rename of the dispatch shape fails loudly instead
// of silently comparing against an empty block.
function dispatchBlock(name) {
  const marker = `if (command === '${name}') {`;
  const start = cliSource.indexOf(marker);
  assert.notEqual(start, -1, `could not find dispatch block for '${name}' in cli.js`);
  let i = start + marker.length;
  let depth = 1;
  while (depth > 0 && i < cliSource.length) {
    if (cliSource[i] === '{') depth++;
    else if (cliSource[i] === '}') depth--;
    i++;
  }
  return cliSource.slice(start, i);
}

// Every `--flag` the implementation actually reads for a command, found by
// scanning its dispatch block for `option('flag-name')` calls -- the only
// mechanism cli.js uses to read a named flag.
function implementedFlags(block) {
  const flags = new Set();
  const re = /option\(\s*'([a-z][a-z0-9-]*)'/g;
  let m;
  while ((m = re.exec(block))) flags.add(m[1]);
  return flags;
}

// Every `--flag` the printed help for a command mentions.
function documentedFlags(helpText) {
  const flags = new Set();
  const re = /--([a-z][a-z0-9-]*)/g;
  let m;
  while ((m = re.exec(helpText))) flags.add(m[1]);
  return flags;
}

// A bare lowercase word immediately after `olimpyx <command>` in a help line
// (not a `--flag` and not an ALL-CAPS placeholder like ID/TAG/SOURCE) reads
// as a positional subcommand keyword -- e.g. `subscribe add --room ID`.
function claimedSubcommands(helpText, name) {
  const claimed = new Set();
  const lineRe = new RegExp(`^olimpyx ${name}\\b(.*)$`, 'gm');
  let m;
  while ((m = lineRe.exec(helpText))) {
    const firstTok = m[1].trim().split(/\s+/)[0] || '';
    if (/^[a-z][a-z-]*$/.test(firstTok)) claimed.add(firstTok);
  }
  return claimed;
}

for (const name of ['subscribe', 'recommendations']) {
  test(`help for '${name}' documents exactly the flags the dispatcher reads`, () => {
    const block = dispatchBlock(name);
    const implemented = implementedFlags(block);
    const documented = documentedFlags(COMMAND_HELP[name]);
    assert.deepEqual(
      [...documented].sort(),
      [...implemented].sort(),
      `'${name}': help flags [${[...documented]}] vs implemented flags [${[...implemented]}] -- ` +
      `the printed help must list exactly the --flags the code reads via option(...)`
    );
  });

  test(`help for '${name}' does not claim a positional subcommand the dispatcher doesn't parse`, () => {
    const block = dispatchBlock(name);
    const claimed = claimedSubcommands(COMMAND_HELP[name], name);
    const dispatcherShiftsPositional = /args\.shift\(\)/.test(block);
    if (claimed.size > 0) {
      assert.ok(
        dispatcherShiftsPositional,
        `'${name}': help implies subcommand(s) [${[...claimed]}] (e.g. "olimpyx ${name} ${[...claimed][0]} ...") ` +
        `but the dispatch block never consumes a positional subcommand via args.shift() -- ` +
        `those arguments would be silently ignored at runtime`
      );
    } else {
      assert.equal(dispatcherShiftsPositional, false,
        `'${name}': dispatcher consumes a positional subcommand via args.shift() but the help ` +
        `never documents one -- update COMMAND_HELP to show it`);
    }
  });
}
