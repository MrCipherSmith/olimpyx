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

test('client SDK knowledge() serializes query options correctly', async () => {
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

  // Empty
  await client.knowledge();
  assert.equal(requestedUrl, 'https://mock.test/v1/knowledge/cards');

  // Search string and options
  await client.knowledge('climate', { scope: 'public', include_archived: true, include_refuted: true });
  assert.equal(requestedUrl, 'https://mock.test/v1/knowledge/cards?q=climate&scope=public&include_archived=true&include_refuted=true');

  // Object options
  await client.knowledge({ scope: 'mine', include_archived: false });
  assert.equal(requestedUrl, 'https://mock.test/v1/knowledge/cards?scope=mine&include_archived=false');
});

test('client SDK createKnowledgeCard, createKnowledgeVersion, and reviewKnowledgeVersion format requests', async () => {
  const requests = [];
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url, opts) => {
      requests.push({ url: String(url), method: opts.method, headers: opts.headers, body: JSON.parse(opts.body || '{}') });
      return new Response(JSON.stringify({ data: { id: 'test' } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  // Create card
  await client.createKnowledgeCard({
    topic: 'Photosynthesis',
    summary: 'Process summary',
    body: 'Details...',
    sources: [{ kind: 'url', uri: 'https://example.com' }]
  }, 'idem-card-1');

  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, 'https://mock.test/v1/knowledge/cards');
  assert.equal(requests[0].headers['idempotency-key'], 'idem-card-1');
  assert.equal(requests[0].body.topic, 'Photosynthesis');

  // Create version
  await client.createKnowledgeVersion('knw_123', {
    expected_latest_version_id: 'knv_old',
    topic: 'Photosynthesis v2',
    summary: 'Updated summary',
    body: 'Updated details...'
  }, 'idem-ver-1');

  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].url, 'https://mock.test/v1/knowledge/cards/knw_123/versions');
  assert.equal(requests[1].headers['idempotency-key'], 'idem-ver-1');
  assert.equal(requests[1].body.expected_latest_version_id, 'knv_old');

  // Review version
  await client.reviewKnowledgeVersion('knv_123', {
    verdict: 'confirm',
    explanation: 'Reproduced results',
    evidence: [{ kind: 'fact', uri: 'Lab notebook #4' }]
  }, 'idem-rev-1');

  assert.equal(requests[2].method, 'POST');
  assert.equal(requests[2].url, 'https://mock.test/v1/knowledge/versions/knv_123/reviews');
  assert.equal(requests[2].headers['idempotency-key'], 'idem-rev-1');
  assert.equal(requests[2].body.verdict, 'confirm');
});

test('client SDK setCardPublication and setCardArchived format PATCH requests', async () => {
  const requests = [];
  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url, opts) => {
      requests.push({ url: String(url), method: opts.method, body: JSON.parse(opts.body || '{}') });
      return new Response(JSON.stringify({ data: { success: true } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await client.setCardPublication('knw_123', true);
  assert.equal(requests[0].method, 'PATCH');
  assert.equal(requests[0].url, 'https://mock.test/v1/knowledge/cards/knw_123/public');
  assert.deepEqual(requests[0].body, { public: true });

  await client.setCardArchived('knw_123', true);
  assert.equal(requests[1].method, 'PATCH');
  assert.equal(requests[1].url, 'https://mock.test/v1/knowledge/cards/knw_123/archive');
  assert.deepEqual(requests[1].body, { archived: true });

  await client.setCardArchived('knw_123', false);
  assert.deepEqual(requests[2].body, { archived: false });
});

test('CLI knowledge card creates proposal with structured sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-card-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'session-credential'), 'secret\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString()
  }));

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/v1/knowledge/cards')) {
        const body = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          data: {
            card_id: 'knw_new_1',
            public: false,
            archived: false,
            status: 'unconfirmed',
            latest: { topic: body.topic, summary: body.summary, sources: body.sources }
          }
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run([
    'knowledge', 'card',
    '--topic', 'CRISPR mechanism',
    '--summary', 'Bacterial defense system',
    '--body', 'Detailed enzymatic body...',
    '--sources', '[{"kind":"url","uri":"https://example.com/crispr"}]',
    '--caller-id', 'call_1'
  ], { cwd: root, preload: preloadPath });

  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.data.card_id, 'knw_new_1');
  assert.equal(parsed.data.public, false);
  assert.equal(parsed.data.archived, false);
  assert.equal(parsed.data.latest.topic, 'CRISPR mechanism');

  await rm(root, { recursive: true, force: true });
});

test('CLI knowledge review submits verdict with evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-review-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'session-credential'), 'secret\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString()
  }));

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/reviews')) {
        const body = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          data: {
            review_id: 'rev_123',
            version_id: 'knv_1',
            verdict: body.verdict,
            explanation: body.explanation
          }
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
  `);

  const res = await run([
    'knowledge', 'review',
    '--version', 'knv_1',
    '--verdict', 'refute',
    '--explanation', 'Failed independent replication',
    '--evidence', '[{"kind":"fact","uri":"assay-log-9"}]',
    '--caller-id', 'call_1'
  ], { cwd: root, preload: preloadPath });

  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.data.review_id, 'rev_123');
  assert.equal(parsed.data.verdict, 'refute');

  await rm(root, { recursive: true, force: true });
});

test('CLI knowledge publish and archive handle flags and credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-pub-arch-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'owner-credential'), 'owner_secret\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'session-credential'), 'session_secret\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString()
  }));

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/public')) {
        const body = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          data: { card_id: 'knw_1', public: body.public }
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/archive')) {
        const body = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          data: { card_id: 'knw_1', archived: body.archived }
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/v1/knowledge/cards')) {
        return new Response(JSON.stringify({
          data: [{ card_id: 'knw_1', public: true, archived: false }],
          page: { next_cursor: null }
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
  `);

  // Publish
  const pubRes = await run(['knowledge', 'publish', '--card', 'knw_1'], { cwd: root, preload: preloadPath });
  assert.equal(pubRes.status, 0, pubRes.stderr);
  assert.equal(JSON.parse(pubRes.stdout).data.public, true);

  // Unpublish
  const unpubRes = await run(['knowledge', 'publish', '--card', 'knw_1', '--unpublish'], { cwd: root, preload: preloadPath });
  assert.equal(unpubRes.status, 0, unpubRes.stderr);
  assert.equal(JSON.parse(unpubRes.stdout).data.public, false);

  // Archive
  const archRes = await run(['knowledge', 'archive', '--card', 'knw_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(archRes.status, 0, archRes.stderr);
  assert.equal(JSON.parse(archRes.stdout).data.archived, true);

  // Search with filters
  const searchRes = await run(['knowledge', 'list', '--q', 'CRISPR', '--include-archived', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(searchRes.status, 0, searchRes.stderr);
  assert.equal(JSON.parse(searchRes.stdout).data.length, 1);

  await rm(root, { recursive: true, force: true });
});

test('client SDK getCardQuorum fetches card and extracts quorum metrics', async () => {
  const mockCard = {
    card_id: 'knw_100',
    status: 'confirmed',
    canonical_version_id: 'knv_1',
    latest_version_id: 'knv_2',
    has_pending_proposal: true,
    has_refuted_proposal: false,
    review_counts: { confirm: 3, refute: 0, comment: 1 },
    latest: {
      version_id: 'knv_2',
      topic: 'Photosynthesis v2',
      status: 'unconfirmed',
      review_counts: { confirm: 1, refute: 0, comment: 0 },
      independent_review_counts: { confirm: 1, refute: 0 },
      quorum: {
        threshold: 2,
        independent_confirms: 1,
        independent_refutes: 0,
        reached: false,
        confirms_needed: 1
      }
    }
  };

  const client = new OlimpyxClient({
    serverUrl: 'https://mock.test',
    fetchImpl: async (url) => {
      assert.equal(String(url), 'https://mock.test/v1/knowledge/cards/knw_100');
      return new Response(JSON.stringify({ data: mockCard }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const quorumRes = await client.getCardQuorum('knw_100');
  assert.equal(quorumRes.data.card_id, 'knw_100');
  assert.equal(quorumRes.data.status, 'confirmed');
  assert.equal(quorumRes.data.canonical_version_id, 'knv_1');
  assert.equal(quorumRes.data.latest_version_id, 'knv_2');
  assert.equal(quorumRes.data.has_pending_proposal, true);
  assert.equal(quorumRes.data.has_refuted_proposal, false);
  assert.equal(quorumRes.data.quorum.threshold, 2);
  assert.equal(quorumRes.data.quorum.independent_confirms, 1);
  assert.equal(quorumRes.data.quorum.confirms_needed, 1);
  assert.equal(quorumRes.data.independent_review_counts.confirm, 1);
});

test('CLI knowledge inspect displays progress bar, canonical vs proposal version, and redacts credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'olimpyx-inspect-cli-'));
  const stateDir = join(root, '.olimpyx');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ serverUrl: 'https://mock.test' }));
  await writeFile(join(stateDir, 'session-credential'), 'secret_token\n', { mode: 0o600 });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: 'ses_1',
    caller_id: 'call_1',
    caller_deadline: new Date(Date.now() + 60000).toISOString()
  }));

  const mockCard = {
    card_id: 'knw_inspect_1',
    status: 'confirmed',
    canonical_version_id: 'knv_1',
    latest_version_id: 'knv_2',
    has_pending_proposal: true,
    has_refuted_proposal: false,
    public: true,
    archived: false,
    latest: {
      version_id: 'knv_2',
      card_id: 'knw_inspect_1',
      version: 2,
      topic: 'Quantum Biology Findings access_token=secret12345',
      summary: 'Quantum effects in light-harvesting complexes',
      body: 'Detailed findings...',
      status: 'unconfirmed',
      review_counts: { confirm: 2, refute: 0, comment: 1 },
      independent_review_counts: { confirm: 1, refute: 0 },
      quorum: {
        threshold: 2,
        independent_confirms: 1,
        independent_refutes: 0,
        reached: false,
        confirms_needed: 1
      }
    }
  };

  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, `
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/heartbeat')) {
        return new Response(JSON.stringify({ data: { session_id: 'ses_1' } }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/v1/knowledge/cards/knw_inspect_1')) {
        return new Response(JSON.stringify({ data: ${JSON.stringify(mockCard)} }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/v1/knowledge/versions/knv_2')) {
        return new Response(JSON.stringify({ data: ${JSON.stringify(mockCard.latest)} }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
  `);

  // Text formatted inspect
  const inspectRes = await run(['knowledge', 'inspect', 'knw_inspect_1', '--caller-id', 'call_1'], { cwd: root, preload: preloadPath });
  assert.equal(inspectRes.status, 0, inspectRes.stderr);
  assert.match(inspectRes.stdout, /Knowledge Inspection:/);
  assert.match(inspectRes.stdout, /Card ID:\s+knw_inspect_1/);
  assert.match(inspectRes.stdout, /Card Status:\s+confirmed/);
  assert.match(inspectRes.stdout, /Canonical Version:\s+knv_1/);
  assert.match(inspectRes.stdout, /Latest Version:\s+knv_2 \(unconfirmed\)/);
  assert.match(inspectRes.stdout, /Pending Proposal:\s+yes/);
  assert.match(inspectRes.stdout, /Quorum Progress:\s+\[■□\] 1\/2 independent confirmations/);
  assert.match(inspectRes.stdout, /Independent Votes:\s+1 confirm\(s\), 0 refute\(s\)/);
  // Credential in topic was redacted
  assert.doesNotMatch(inspectRes.stdout, /secret12345/);
  assert.match(inspectRes.stdout, /\[REDACTED\]/);

  // JSON inspect with --json
  const jsonRes = await run(['knowledge', 'inspect', 'knw_inspect_1', '--caller-id', 'call_1', '--json'], { cwd: root, preload: preloadPath });
  assert.equal(jsonRes.status, 0, jsonRes.stderr);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.equal(parsed.card_id, 'knw_inspect_1');
  assert.equal(parsed.canonical_version_id, 'knv_1');
  assert.equal(parsed.has_pending_proposal, true);
  assert.equal(parsed.progress, '[■□] 1/2 independent confirmations');
  assert.equal(parsed.quorum.threshold, 2);
  assert.equal(parsed.quorum.independent_confirms, 1);

  // Inspect version directly
  const verRes = await run(['knowledge', 'inspect', 'knv_2', '--caller-id', 'call_1', '--json'], { cwd: root, preload: preloadPath });
  assert.equal(verRes.status, 0, verRes.stderr);
  const verParsed = JSON.parse(verRes.stdout);
  assert.equal(verParsed.version_id, 'knv_2');
  assert.equal(verParsed.canonical_version_id, 'knv_1');

  await rm(root, { recursive: true, force: true });
});

