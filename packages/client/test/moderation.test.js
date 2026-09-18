import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { OlimpyxClient } from '../src/client.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

function run(args, { cwd, input = '', env = {}, preload = null }) {
  return new Promise((resolveResult) => {
    const nodeArgs = preload ? ['--import', preload, cli, ...args] : [cli, ...args];
    const child = spawn(process.execPath, nodeArgs, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('client SDK getOwnerIncidents formats query parameters correctly', async () => {
  let requestedUrl = '';
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const res = await client.getOwnerIncidents({ limit: 15, status: 'resolved' });
  assert.deepEqual(res.data, []);
  assert.equal(requestedUrl, 'https://mock.test/v1/owners/me/incidents?limit=15&status=resolved');
});

test('client SDK appealIncident formats POST request with reason and evidence', async () => {
  let requestedUrl = '';
  let requestedMethod = '';
  let requestedBody = null;

  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url, opts) => {
      requestedUrl = String(url);
      requestedMethod = opts.method;
      requestedBody = JSON.parse(opts.body || '{}');
      return new Response(JSON.stringify({ data: { id: 'inc_123', status: 'appeal_pending' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const res = await client.appealIncident('inc_123', {
    reason: 'False positive detection',
    evidence: [{ kind: 'message', uri: 'room/123/messages/456' }]
  });

  assert.equal(requestedMethod, 'POST');
  assert.equal(requestedUrl, 'https://mock.test/v1/owners/me/incidents/inc_123/appeal');
  assert.equal(requestedBody.reason, 'False positive detection');
  assert.deepEqual(requestedBody.evidence, [{ kind: 'message', uri: 'room/123/messages/456' }]);
  assert.equal(res.data.status, 'appeal_pending');
});

test('client SDK createReport formats POST request with target, category, and explanation', async () => {
  let requestedUrl = '';
  let requestedMethod = '';
  let requestedBody = null;

  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url, opts) => {
      requestedUrl = String(url);
      requestedMethod = opts.method;
      requestedBody = JSON.parse(opts.body || '{}');
      return new Response(JSON.stringify({ data: { report_id: 'rpt_1', status: 'escalated' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const res = await client.createReport({
    targetKind: 'message',
    targetId: 'msg_999',
    category: 'spam',
    explanation: 'Spamming identical messages'
  });

  assert.equal(requestedMethod, 'POST');
  assert.equal(requestedUrl, 'https://mock.test/v1/reports');
  assert.deepEqual(requestedBody.target, { kind: 'message', id: 'msg_999' });
  assert.equal(requestedBody.category, 'spam');
  assert.equal(requestedBody.explanation, 'Spamming identical messages');
  assert.equal(res.data.status, 'escalated');
});

test('CLI incidents command queries incidents and redacts credentials in output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-incidents-cli-'));
  try {
    const stateDir = join(root, '.olimpyx');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
    await writeFile(join(stateDir, 'owner-credential'), 'owner_secret_token_123\n', { mode: 0o600 });

    const preloadPath = join(root, 'preload.mjs');
    await writeFile(preloadPath, `
      globalThis.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/v1/owners/me/incidents')) {
          return new Response(JSON.stringify({
            data: [
              {
                id: 'inc_test_1',
                sanction_kind: 'warning',
                access_token: 'secret_leak_should_be_redacted',
                status: 'resolved'
              }
            ],
            page: { next_cursor: null }
          }), { headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
      };
    `);

    const res = await run(['incidents', '--status', 'resolved'], { cwd: root, preload: preloadPath });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.data[0].id, 'inc_test_1');
    assert.equal(parsed.data[0].sanction_kind, 'warning');
    assert.equal(parsed.data[0].access_token, '[REDACTED]', 'Access token should be redacted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI appeal command validates required flags and submits appeal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-appeal-cli-'));
  try {
    const stateDir = join(root, '.olimpyx');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
    await writeFile(join(stateDir, 'owner-credential'), 'owner_secret_token_123\n', { mode: 0o600 });

    // Missing required args
    const missingArgs = await run(['appeal'], { cwd: root });
    assert.notEqual(missingArgs.status, 0);
    assert.match(missingArgs.stderr, /--incident <ID> is required/);

    const missingReason = await run(['appeal', '--incident', 'inc_123'], { cwd: root });
    assert.notEqual(missingReason.status, 0);
    assert.match(missingReason.stderr, /--reason <text> is required/);

    const preloadPath = join(root, 'preload.mjs');
    await writeFile(preloadPath, `
      globalThis.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/v1/owners/me/incidents/inc_123/appeal')) {
          const body = JSON.parse(opts.body);
          return new Response(JSON.stringify({
            data: {
              id: 'inc_123',
              status: 'appeal_pending',
              appeal_status: 'pending',
              appeal_reason: body.reason,
              session_token: 'secret_leak'
            }
          }), { headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
      };
    `);

    const res = await run(['appeal', '--incident', 'inc_123', '--reason', 'Legitimate operations'], { cwd: root, preload: preloadPath });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.data.id, 'inc_123');
    assert.equal(parsed.data.appeal_status, 'pending');
    assert.equal(parsed.data.session_token, '[REDACTED]', 'Credentials must be redacted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI report command validates required flags and creates report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-report-cli-'));
  try {
    const stateDir = join(root, '.olimpyx');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
    await writeFile(join(stateDir, 'owner-credential'), 'owner_secret_token_123\n', { mode: 0o600 });

    const missingKind = await run(['report'], { cwd: root });
    assert.notEqual(missingKind.status, 0);
    assert.match(missingKind.stderr, /--kind <profile\|message\|knowledge_version> is required/);

    const missingTarget = await run(['report', '--kind', 'message'], { cwd: root });
    assert.notEqual(missingTarget.status, 0);
    assert.match(missingTarget.stderr, /--target <ID> is required/);

    const missingCat = await run(['report', '--kind', 'message', '--target', 'msg_1'], { cwd: root });
    assert.notEqual(missingCat.status, 0);
    assert.match(missingCat.stderr, /--category <cat> is required/);

    const missingReason = await run(['report', '--kind', 'message', '--target', 'msg_1', '--category', 'spam'], { cwd: root });
    assert.notEqual(missingReason.status, 0);
    assert.match(missingReason.stderr, /--reason <text> is required/);

    const preloadPath = join(root, 'preload.mjs');
    await writeFile(preloadPath, `
      globalThis.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/v1/reports')) {
          const body = JSON.parse(opts.body);
          return new Response(JSON.stringify({
            data: {
              report_id: 'rpt_123',
              status: 'escalated',
              enrollment_token: 'secret_leak'
            }
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
      };
    `);

    const res = await run([
      'report',
      '--kind', 'message',
      '--target', 'msg_1',
      '--category', 'spam',
      '--reason', 'Sending automated spam'
    ], { cwd: root, preload: preloadPath });

    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.data.report_id, 'rpt_123');
    assert.equal(parsed.data.status, 'escalated');
    assert.equal(parsed.data.enrollment_token, '[REDACTED]', 'Credentials must be redacted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
