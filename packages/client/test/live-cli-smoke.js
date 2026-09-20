import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const serverUrl = process.env.OLIMPYX_URL;
if (!serverUrl) { process.stderr.write('OLIMPYX_URL is required.\n'); process.exit(2); }
const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');
const root = await mkdtemp(join(tmpdir(), 'olimpyx-live-cli-'));
const callerId = `live-cli-${crypto.randomUUID()}`;
const password = `Live-cli-${crypto.randomUUID()}!`;
const email = `olimpyx-cli-${crypto.randomUUID()}@example.test`;
const outputs = [];

function run(args, input = '') { return new Promise((resolve) => { const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('close', status => { outputs.push(stdout, stderr); resolve({ status, stdout, stderr }); }); child.stdin.end(input); }); }
async function api(path, options = {}) { const response = await fetch(`${serverUrl}${path}`, options); const body = await response.json(); return { response, body }; }

let sessionStarted = false;
try {
  const registration = await api('/v1/owners/register', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ email, password, display_name: 'CLI live smoke' }) });
  assert.equal(registration.response.status, 201, JSON.stringify(registration.body));
  assert.equal((await run(['configure', '--server', serverUrl])).status, 0);
  assert.equal((await run(['owner-login', '--email', email, '--password-stdin'], `${password}\n`)).status, 0);
  const profile = JSON.stringify({ name: 'CLI Smoke Agent', role: 'tester', bio: 'Temporary live test', interests: ['testing'], capabilities: ['messaging'] });
  const enrollment = await run(['enroll', '--profile', profile]); assert.equal(enrollment.status, 0, enrollment.stderr);
  const agentToken = await readFile(join(root, '.olimpyx', 'credential'), 'utf8');
  const rejected = await api('/v1/rooms', { headers: { authorization: `Bearer ${agentToken}` } });
  assert.equal(rejected.response.status, 403, 'agent credential unexpectedly accessed participant content');
  const begin = await run(['session', 'begin', '--caller-id', callerId, '--host', 'codex']); assert.equal(begin.status, 0, begin.stderr); sessionStarted = true;
  const guide = JSON.parse(begin.stdout).bootstrap.city_guide;
  assert.equal(guide.api_path, '/v1/city-guide');
  const fetchedGuide = await run(['request', 'GET', guide.api_path, '', '--caller-id', callerId]);
  assert.equal(fetchedGuide.status, 0, fetchedGuide.stderr);
  assert.match(JSON.parse(fetchedGuide.stdout).data.body, /^# Olimpyx: Agent City Guide/);
  const sessionToken = await readFile(join(root, '.olimpyx', 'calls', callerId, 'session-credential'), 'utf8');
  const rooms = await run(['rooms', '--caller-id', callerId]); assert.equal(rooms.status, 0, rooms.stderr);
  const created = await run(['request', 'POST', '/v1/rooms', JSON.stringify({ title: `CLI smoke ${crypto.randomUUID()}`, description: 'Temporary' }), '--caller-id', callerId]); assert.equal(created.status, 0, created.stderr); const roomId = JSON.parse(created.stdout).data.room_id;
  const sent = await run(['message', '--room', roomId, '--body', 'Bounded CLI smoke message', '--caller-id', callerId]); assert.equal(sent.status, 0, sent.stderr);
  const before = JSON.parse(await readFile(join(root, '.olimpyx', 'calls', callerId, 'session.json'), 'utf8')).inbox_cursor;
  const waited = await run(['wait', '--after', before, '--timeout-ms', '1000', '--caller-id', callerId]); assert.equal(waited.status, 0, waited.stderr);
  const after = JSON.parse(await readFile(join(root, '.olimpyx', 'calls', callerId, 'session.json'), 'utf8')).inbox_cursor;
  assert.ok(typeof after === 'string' || after === null);
  const end = await run(['session', 'end', '--caller-id', callerId]); assert.equal(end.status, 0, end.stderr); sessionStarted = false;
  const combined = outputs.join('');
  for (const secret of [registration.body.data.access_token, agentToken, sessionToken]) assert.equal(combined.includes(secret), false, 'CLI output leaked a credential');
  process.stdout.write('Live CLI smoke passed: enrollment, token separation, session content, message, bounded wait/cursor, end, and output redaction.\n');
} finally {
  if (sessionStarted) await run(['session', 'end', '--caller-id', callerId]);
}
