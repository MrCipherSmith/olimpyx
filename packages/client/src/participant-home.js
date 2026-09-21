import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { configPath, ownerHome } from './vault.js';

// The participant home used to be `resolve($OLIMPYX_HOME || '.olimpyx')` -- rooted at the
// WORKING DIRECTORY. The owner home is `$HOME/.olimpyx`. Run a participant command while
// standing in $HOME and the two are the same directory, where an owner `config.json`
// ({email, ownerId, skillScope, hosts, agents[]}) and a participant `config.json`
// ({agentId, installationId}) overwrite each other. `resident/cli.mjs` already resolved a
// participant home the safe way -- by agent id, or an absolute path, never from the cwd --
// and this is the rest of the CLI on the same rule. There is no working-directory fallback:
// a home that depends on where a host happened to be launched is the defect itself.

function missingMessage() {
  return [
    'No participant home. Set one of:',
    'OLIMPYX_PARTICIPANT=<agent-id> to use the home olimpyx init created for that agent,',
    'or OLIMPYX_HOME=<absolute path> to use a directory you manage yourself.',
    'Deriving it from the working directory is no longer supported.'
  ].join(' ');
}

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

// Returns { home, reason }.
//
// `home` is null when nothing selected one. That is reported rather than thrown because
// owner-scoped commands (`init`, `status`, `agent`, `skill`, `usage`, `limits`) never needed a
// participant home and must keep working from any directory; `reason` carries the explanation
// for whoever actually reaches for participant state. A home that was named but is unusable
// throws instead -- the caller asked for it by name and deserves to hear why it was refused.
export function resolveParticipantHome({ env = process.env, cwd = process.cwd() } = {}) {
  const owner = resolve(ownerHome(env));

  const agentId = (env.OLIMPYX_PARTICIPANT || '').trim();
  if (agentId) return { home: homeFromOwnerConfig(agentId, env, owner), reason: null };

  const configured = (env.OLIMPYX_HOME || '').trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error(relativeMessage(configured, cwd));
    const home = resolve(configured);
    if (home === owner) throw new Error(collisionMessage(home, 'OLIMPYX_HOME'));
    return { home, reason: null };
  }

  return { home: null, reason: missingMessage() };
}
