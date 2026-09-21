import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { OlimpyxClient } from './client.js';
import { LocalState } from './state.js';
import { CHARACTERS, characterById, publicProfile, writeCatalog } from './characters.js';
import { configPath, ownerHome, readVault, vaultExists, writeVault } from './vault.js';
import { installStarterSkill, loadPlaybookSource, toGlobalPlaybook } from './skill-install.js';
import { t as defaultT } from './i18n.js';

export const DEFAULT_SERVER = 'https://olimpyx.mrciphersmith.com';
export const OWNER_CONFIG_KIND = 'olimpyx.owner-config/1';

export function isTransientNetworkError(error) {
  if (!error) return false;
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  const code = error.code || error.cause?.code;
  return Boolean(code && ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code));
}

export function friendlyInitError(error, serverUrl = DEFAULT_SERVER, t = defaultT) {
  if (error?.status === 409) return t('error.emailTaken');
  if (error?.status === 401) return t('error.badCredentials');
  if (error?.status === 422) return t('error.validation');
  if (error?.status === 429) return t('error.rateLimited');
  if (isTransientNetworkError(error) || error instanceof TypeError) {
    return t('error.unreachable', { url: serverUrl });
  }
  return error?.message || t('error.unknown');
}

export function agentHomeFor(id, plan, env = process.env) {
  const root = plan.skillScope === 'local' ? join(plan.projectPath, '.olimpyx') : ownerHome(env);
  return join(root, 'agents', id);
}

export function summarizePlan(plan, t = defaultT) {
  const characters = (plan.characterIds || []).map((id) => characterById(id)?.name || id);
  const skillWhere = plan.skillScope === 'global'
    ? t('plan.skill.global')
    : t('plan.skill.local', { path: plan.projectPath });
  return [
    t('plan.server', { url: plan.serverUrl }),
    t('plan.account', {
      mode: t(plan.mode === 'register' ? 'plan.account.register' : 'plan.account.login'),
      email: plan.email
    }),
    plan.displayName ? t('plan.name', { name: plan.displayName }) : null,
    t('plan.skill', { where: skillWhere }),
    t('plan.hosts', { hosts: (plan.hosts || []).join(', ') || t('plan.none') }),
    t('plan.agents', { agents: characters.length ? characters.join(', ') : t('plan.agents.none') })
  ].filter(Boolean).join('\n');
}

async function authenticate(plan, client) {
  if (plan.mode === 'register') {
    return client.request('POST', '/v1/owners/register', {
      email: plan.email,
      password: plan.password,
      display_name: plan.displayName
    });
  }
  return client.request('POST', '/v1/owners/login', {
    email: plan.email,
    password: plan.password
  });
}

async function enrollOne(plan, ownerClient, character, env) {
  const profile = publicProfile(character);
  const installationId = crypto.randomUUID();
  const enrollment = await ownerClient.request('POST', '/v1/owners/me/enrollment-tokens', { label: character.id });
  const result = await ownerClient.request('POST', '/v1/agents/enroll', {
    enrollment_token: enrollment.data.enrollment_token,
    installation_id: installationId,
    profile
  }, { token: null });
  const home = agentHomeFor(character.id, plan, env);
  const state = new LocalState(home);
  await state.saveCredential(result.data.agent_token);
  await state.saveConfig({
    serverUrl: plan.serverUrl,
    installationId,
    agentId: result.data.agent.agent_id,
    profileRevision: result.data.agent.profile_revision,
    characterId: character.id,
    ownerId: plan.ownerId ?? null
  });
  await state.savePersona(profile, 'init catalog');
  if (character.id === 'archi') {
    for (const [source, destination] of [['archi-citizen.md', 'CITIZEN.md'], ['archi-decide.md', 'DECIDE.md']]) {
      const template = await readFile(new URL(`../data/skill/${source}`, import.meta.url), 'utf8');
      try {
        await writeFile(join(home, destination), template, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  }
  return {
    id: character.id,
    agent_id: result.data.agent.agent_id,
    credential: result.data.agent_token,
    home
  };
}

export async function applyInit(plan, { env = process.env, fetchImpl = fetch, onProgress = () => {} } = {}) {
  const home = ownerHome(env);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const client = new OlimpyxClient({ serverUrl: plan.serverUrl, token: null, fetchImpl });

  onProgress('account');
  let auth;
  try {
    auth = await authenticate(plan, client);
  } catch (error) {
    const wrapped = new Error(friendlyInitError(error, plan.serverUrl));
    wrapped.cause = error;
    throw wrapped;
  }
  const owner = auth.data.owner;
  const accessToken = auth.data.access_token;
  plan.ownerId = owner.owner_id;
  const ownerClient = new OlimpyxClient({ serverUrl: plan.serverUrl, token: accessToken, fetchImpl });

  onProgress('vault');
  const enrolled = [];
  const selected = (plan.characterIds || []).map((id) => characterById(id)).filter(Boolean);
  for (const character of selected) {
    onProgress(`agent:${character.id}`);
    enrolled.push(await enrollOne(plan, ownerClient, character, env));
  }

  const vault = {
    owner: {
      email: plan.email,
      password: plan.password,
      access_token: accessToken,
      expires_at: auth.data.expires_at ?? null,
      owner_id: owner.owner_id,
      display_name: owner.display_name
    },
    agents: Object.fromEntries(enrolled.map((item) => [item.id, { agent_id: item.agent_id, credential: item.credential, home: item.home }]))
  };
  await writeVault(vault, env);

  const config = {
    // A participant config ({agentId, installationId}) used to be able to land on this exact
    // path. `readOwnerStatus` parsed whatever was there as owner config and reported an owner
    // with no email and no agents. The marker makes the two tellable apart.
    kind: OWNER_CONFIG_KIND,
    serverUrl: plan.serverUrl,
    email: plan.email,
    displayName: owner.display_name,
    ownerId: owner.owner_id,
    skillScope: plan.skillScope,
    projectPath: plan.skillScope === 'local' ? plan.projectPath : null,
    hosts: plan.hosts,
    agents: enrolled.map((item) => ({ id: item.id, agent_id: item.agent_id, home: item.home }))
  };
  await writeFile(configPath(env), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  onProgress('catalog');
  await writeCatalog(join(home, 'characters'), CHARACTERS);
  if (plan.skillScope === 'local') {
    await writeCatalog(join(plan.projectPath, '.olimpyx', 'characters'), CHARACTERS);
  }

  onProgress('playbook');
  await writeFile(join(home, 'skill.md'), toGlobalPlaybook(await loadPlaybookSource()));

  onProgress('skills');
  const installedSkills = [];
  const homeDir = env.HOME || homedir();
  for (const host of plan.hosts || []) {
    installedSkills.push(await installStarterSkill(host, {
      scope: plan.skillScope,
      projectPath: plan.projectPath,
      home: homeDir
    }));
  }

  return { home, config, enrolled, installedSkills };
}

export async function readOwnerStatus(env = process.env, t = defaultT) {
  const initialized = await vaultExists(env);
  if (!initialized) {
    return { initialized: false, hint: t('status.notInitialized') };
  }
  try {
    const config = JSON.parse(await readFile(configPath(env), 'utf8'));
    if (config.kind !== OWNER_CONFIG_KIND && (config.agentId || config.installationId)) {
      return { initialized: true, hint: t('status.configIsParticipant') };
    }
    return {
      initialized: true,
      serverUrl: config.serverUrl,
      email: config.email,
      displayName: config.displayName,
      skillScope: config.skillScope,
      projectPath: config.projectPath,
      agents: config.agents || []
    };
  } catch {
    return { initialized: true, hint: t('status.configUnreadable') };
  }
}

export async function addAgentFromCatalog(id, { env = process.env, fetchImpl = fetch, t = defaultT } = {}) {
  const character = characterById(id);
  if (!character) throw new Error(t('agent.unknownCharacter', { id }));
  const vault = await readVault(env);
  const config = JSON.parse(await readFile(configPath(env), 'utf8'));
  if (vault.agents?.[id]) throw new Error(t('agent.alreadyAdded', { name: character.name }));
  const plan = {
    serverUrl: config.serverUrl,
    skillScope: config.skillScope || 'global',
    projectPath: config.projectPath,
    ownerId: config.ownerId
  };
  const ownerClient = new OlimpyxClient({ serverUrl: config.serverUrl, token: vault.owner.access_token, fetchImpl });
  const enrolled = await enrollOne(plan, ownerClient, character, env);
  vault.agents = { ...vault.agents, [id]: { agent_id: enrolled.agent_id, credential: enrolled.credential, home: enrolled.home } };
  await writeVault(vault, env);
  config.agents = [...(config.agents || []), { id, agent_id: enrolled.agent_id, home: enrolled.home }];
  await writeFile(configPath(env), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return enrolled;
}
