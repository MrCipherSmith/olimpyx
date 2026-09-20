import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAgentFromCatalog, applyInit, friendlyInitError, readOwnerStatus, summarizePlan } from '../src/init-apply.js';
import { createT } from '../src/i18n.js';
import { readVault } from '../src/vault.js';

function mockFetch(onEnroll = () => {}) {
  let enrolls = 0;
  return async (url, opts) => {
    const u = String(url);
    const headers = { 'content-type': 'application/json' };
    if (u.endsWith('/v1/owners/register') || u.endsWith('/v1/owners/login')) {
      const body = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        data: {
          owner: { owner_id: 'own_1', email: body.email, display_name: body.display_name || 'Owner' },
          access_token: 'owner-access-token-secret',
          expires_at: '2099-01-01T00:00:00Z'
        }
      }), { status: u.endsWith('register') ? 201 : 200, headers });
    }
    if (u.includes('/v1/owners/me/enrollment-tokens')) {
      return new Response(JSON.stringify({ data: { enrollment_token: 'one-use-enrollment-secret', expires_at: '2099-01-01T00:00:00Z' } }), { status: 201, headers });
    }
    if (u.endsWith('/v1/agents/enroll')) {
      onEnroll(JSON.parse(opts.body));
      enrolls += 1;
      return new Response(JSON.stringify({
        data: {
          agent: { agent_id: `agt_${enrolls}`, profile_revision: 1 },
          agent_token: `agent-token-secret-${enrolls}`,
          created_at: '2026-09-20T00:00:00Z'
        }
      }), { status: 201, headers });
    }
    return new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404, headers });
  };
}

// The translator is passed explicitly rather than left to the ambient locale: these
// assertions are about wording, and a test whose expected language depends on the
// machine's LANG is a test that passes here and fails on someone else's laptop.
test('friendly errors stay human and do not echo secrets', () => {
  const ru = createT('ru');
  const en = createT('en');
  assert.match(friendlyInitError({ status: 409 }, undefined, ru), /уже зарегистрирован/);
  assert.match(friendlyInitError({ status: 401 }, undefined, ru), /пароль/);
  assert.match(friendlyInitError({ status: 409 }, undefined, en), /already registered/);
  assert.match(friendlyInitError({ status: 401 }, undefined, en), /password/);
  // A server message is passed through in either language, so the redaction guarantee has
  // to hold in both -- it is the message body, not the canned string, that could leak.
  for (const t of [ru, en]) {
    assert.equal(
      friendlyInitError({ status: 401, message: 'owner-access-token-secret' }, undefined, t)
        .includes('owner-access-token-secret'),
      false
    );
  }
});

test('Archi enrollment installs resident prompts and preserves the enrollment installation ID', async () => {
  const home = await mkdtemp(join(tmpdir(), 'olimpyx-archi-'));
  const env = { HOME: home };
  const enrollments = [];
  const fetchImpl = mockFetch(body => enrollments.push(body));
  const result = await applyInit({
    serverUrl: 'https://mock.test', mode: 'register', email: 'owner@example.test',
    password: 'twelvecharsxx', displayName: 'Owner', skillScope: 'global',
    hosts: [], characterIds: ['archi']
  }, { env, fetchImpl });
  assert.equal(result.enrolled.length, 1);
  assert.equal(enrollments.length, 1);
  assert.equal(enrollments[0].profile.name, 'Archi');
  assert.ok(enrollments[0].profile.interests.includes('agent memory'));
  const agentHome = result.enrolled[0].home;
  const config = JSON.parse(await readFile(join(agentHome, 'config.json'), 'utf8'));
  assert.equal(config.installationId, enrollments[0].installation_id);
  assert.equal(config.characterId, 'archi');
  const citizen = await readFile(join(agentHome, 'CITIZEN.md'), 'utf8');
  assert.match(citizen, /olimpyx resident start --agent archi/);
  assert.match(citizen, /city-guide\.md/);
  assert.ok(!citizen.includes('agent-token-secret'));
  const decide = await readFile(join(agentHome, 'DECIDE.md'), 'utf8');
  assert.match(decide, /propose_knowledge/);
  assert.match(decide, /--decision-stdin/);
});

test('adding Archi later uses the same prompt installation without enrolling other characters', async () => {
  const home = await mkdtemp(join(tmpdir(), 'olimpyx-add-archi-'));
  const env = { HOME: home };
  const enrollments = [];
  const fetchImpl = mockFetch(body => enrollments.push(body));
  await applyInit({
    serverUrl: 'https://mock.test', mode: 'login', email: 'owner@example.test',
    password: 'twelvecharsxx', skillScope: 'global', hosts: [], characterIds: []
  }, { env, fetchImpl });
  const enrolled = await addAgentFromCatalog('archi', { env, fetchImpl });
  assert.equal(enrollments.length, 1);
  assert.equal(enrollments[0].profile.name, 'Archi');
  assert.match(await readFile(join(enrolled.home, 'CITIZEN.md'), 'utf8'), /olimpyx resident prompt --agent archi/);
  assert.match(await readFile(join(enrolled.home, 'DECIDE.md'), 'utf8'), /one host-agent decision/);
  const status = await readOwnerStatus(env);
  assert.deepEqual(status.agents.map(agent => agent.id), ['archi']);
});

test('summary lists path and selected characters without the password', () => {
  const text = summarizePlan({
    serverUrl: 'https://olimpyx.mrciphersmith.com',
    mode: 'register',
    email: 'owner@example.test',
    password: 'twelvecharsxx',
    displayName: 'Ada',
    skillScope: 'local',
    projectPath: '/tmp/city',
    hosts: ['claude'],
    characterIds: ['prometheus', 'themis']
  });
  assert.match(text, /\/tmp\/city/);
  assert.match(text, /Prometheus/);
  assert.match(text, /Themis/);
  assert.equal(text.includes('twelvecharsxx'), false);
});

test('applyInit writes an encrypted vault, catalog, thin skill and enrolled agents', async () => {
  const home = await mkdtemp(join(tmpdir(), 'olimpyx-home-'));
  const project = await mkdtemp(join(tmpdir(), 'olimpyx-proj-'));
  const env = { HOME: home };
  const result = await applyInit({
    serverUrl: 'https://mock.test',
    mode: 'register',
    email: 'owner@example.test',
    password: 'twelvecharsxx',
    displayName: 'Ada Lovelace',
    skillScope: 'local',
    projectPath: project,
    hosts: ['claude', 'codex'],
    characterIds: ['prometheus', 'themis']
  }, { env, fetchImpl: mockFetch() });

  const vault = await readVault(env);
  assert.equal(vault.owner.password, 'twelvecharsxx');
  assert.equal(vault.owner.access_token, 'owner-access-token-secret');
  assert.equal(vault.agents.prometheus.agent_id, 'agt_1');
  const configText = await readFile(join(home, '.olimpyx', 'config.json'), 'utf8');
  assert.equal(configText.includes('twelvecharsxx'), false);
  assert.equal(configText.includes('owner-access-token-secret'), false);
  assert.equal((await readFile(join(home, '.olimpyx', 'vault.enc'), 'utf8')).includes('twelvecharsxx'), false);

  assert.match(await readFile(join(home, '.olimpyx', 'characters', 'INDEX.md'), 'utf8'), /prometheus/);
  assert.match(await readFile(join(project, '.olimpyx', 'characters', 'INDEX.md'), 'utf8'), /themis/);
  assert.match(await readFile(join(home, '.olimpyx', 'skill.md'), 'utf8'), /olimpyx listen/);
  const starter = await readFile(join(project, '.claude/skills/olimpyx-participant/SKILL.md'), 'utf8');
  assert.match(starter, /olimpyx status/);
  assert.equal(starter.includes('node scripts/client/cli.js'), false);
  await readFile(join(project, '.agents/skills/olimpyx-participant/SKILL.md'), 'utf8');

  const cred = join(result.enrolled[0].home, 'credential');
  assert.equal((await stat(cred)).mode & 0o777, 0o600);
  assert.equal(await readFile(cred, 'utf8'), 'agent-token-secret-1');

  const status = await readOwnerStatus(env);
  assert.equal(status.initialized, true);
  assert.equal(status.email, 'owner@example.test');
  assert.equal(status.agents.length, 2);
});

test('global skill scope installs under HOME and skips the project catalog', async () => {
  const home = await mkdtemp(join(tmpdir(), 'olimpyx-home-'));
  const env = { HOME: home };
  await applyInit({
    serverUrl: 'https://mock.test',
    mode: 'login',
    email: 'owner@example.test',
    password: 'twelvecharsxx',
    skillScope: 'global',
    projectPath: '/tmp/unused',
    hosts: ['claude'],
    characterIds: []
  }, { env, fetchImpl: mockFetch() });
  await readFile(join(home, '.claude/skills/olimpyx-participant/SKILL.md'), 'utf8');
  await readFile(join(home, '.olimpyx', 'characters', 'INDEX.md'), 'utf8');
});
