import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { configPath, ownerHome } from './vault.js';

// The participant home used to be `resolve($OLIMPYX_HOME || '.olimpyx')` -- rooted at the
// WORKING DIRECTORY. The owner home is `$HOME/.olimpyx`. Run a participant command while
// standing in $HOME and the two are the same directory, where an owner `config.json`
// ({email, ownerId, skillScope, hosts, agents[]}) and a participant `config.json`
// ({agentId, installationId}) overwrite each other. `resident/cli.mjs` already resolves a
// participant home the safe way -- by agent id, or an absolute path, never from the cwd --
// and this brings the rest of the CLI onto the same rule.
export const LEGACY_HOME_DIRNAME = '.olimpyx';

function collisionMessage(home, source) {
  return [
    `${source} resolves the participant home to ${home}, which is the owner home.`,
    'The owner home holds vault.enc and the owner config; a participant home holds an agent',
    'credential and its sessions. Both write config.json at that path, so one silently',
    'replaces the other.',
    `Set OLIMPYX_HOME to a different absolute directory (for example ${join(home, 'agents', '<agent-id>')}),`,
    'or set OLIMPYX_PARTICIPANT=<agent-id> to use the home olimpyx init created for that agent.'
  ].join(' ');
}

function relativeMessage(raw, cwd) {
  return [
    `OLIMPYX_HOME must be an absolute path; got "${raw}".`,
    'A relative value made an agent\'s home depend on where its host happened to be launched.',
    `Use: export OLIMPYX_HOME=${resolve(cwd, raw)}`
  ].join(' ');
}

function legacyNotice(home) {
  return [
    'olimpyx: deriving the participant home from the working directory is deprecated',
    `and will be refused in a future release (it resolved to ${home}).`,
    `Set an absolute path with: export OLIMPYX_HOME=${home}`,
    'or select an initialised agent with: export OLIMPYX_PARTICIPANT=<agent-id>'
  ].join(' ');
}

function homeFromOwnerConfig(agentId, env, owner) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath(env), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`OLIMPYX_PARTICIPANT=${agentId} needs an owner config at ${configPath(env)}. Run: olimpyx init`);
    }
    throw error;
  }
  const entry = config.agents?.find((agent) => agent.id === agentId);
  if (!entry?.home || !isAbsolute(entry.home)) {
    throw new Error(`OLIMPYX_PARTICIPANT=${agentId} is not an initialised agent. Run: olimpyx agent add ${agentId} (or olimpyx init)`);
  }
  const home = resolve(entry.home);
  if (home === owner) throw new Error(collisionMessage(home, `The owner config entry for "${agentId}"`));
  return home;
}

// Returns { home, notice, reason }.
//
// `home` is null only for the legacy working-directory path when it lands on the owner home:
// owner-scoped commands legitimately run from $HOME and must keep working, so that case is
// reported rather than thrown, and `reason` carries the explanation for whoever actually needs
// a participant home. Every other refusal throws, because the caller asked for it by name.
export function resolveParticipantHome({ env = process.env, cwd = process.cwd() } = {}) {
  const owner = resolve(ownerHome(env));

  const agentId = (env.OLIMPYX_PARTICIPANT || '').trim();
  if (agentId) return { home: homeFromOwnerConfig(agentId, env, owner), notice: null, reason: null };

  const configured = (env.OLIMPYX_HOME || '').trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error(relativeMessage(configured, cwd));
    const home = resolve(configured);
    if (home === owner) throw new Error(collisionMessage(home, 'OLIMPYX_HOME'));
    return { home, notice: null, reason: null };
  }

  const legacy = resolve(cwd, LEGACY_HOME_DIRNAME);
  if (legacy === owner) {
    return { home: null, notice: null, reason: collisionMessage(legacy, `The working directory (${cwd})`) };
  }
  return { home: legacy, notice: legacyNotice(legacy), reason: null };
}
