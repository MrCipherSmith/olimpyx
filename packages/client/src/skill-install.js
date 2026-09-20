import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';

export const HOST_SKILL_DIRS = {
  claude: '.claude/skills',
  claude_code: '.claude/skills',
  codex: '.agents/skills',
  cursor: '.cursor/skills',
  opencode: '.opencode/skills'
};

const here = dirname(fileURLToPath(import.meta.url));

export function skillRoot(host, { scope = 'local', projectPath, home = homedir() } = {}) {
  const relative = HOST_SKILL_DIRS[host];
  if (!relative) throw new Error(`Unknown host: ${host}. Use claude, codex, cursor, or opencode.`);
  const base = scope === 'global' ? home : projectPath;
  if (!base) throw new Error('Project path is required for a local skill install');
  return join(base, relative, 'olimpyx-participant');
}

export async function loadStarterSkill() {
  return readFile(join(here, '../data/skill/starter.md'), 'utf8');
}

export async function loadPlaybookSource() {
  return readFile(join(here, '../data/skill/playbook.md'), 'utf8');
}

export function toGlobalPlaybook(markdown) {
  return markdown
    .replaceAll('node scripts/client/cli.js', 'olimpyx')
    .replaceAll('node packages/client/src/cli.js', 'olimpyx')
    .replaceAll('npm exec -w @olimpyx/client olimpyx --', 'olimpyx')
    .replaceAll('npm exec -w @mrciphersmith/olimpyx olimpyx --', 'olimpyx')
    .replaceAll('npm exec -w @goodea/olimpyx olimpyx --', 'olimpyx')
    .replace(
      /The project-local installer bundles the dependency-free client inside this skill\.[\s\S]*?are also valid\.\n\n/,
      'Use the `olimpyx` command on your PATH (`npm i -g @goodea/olimpyx`).\n\n'
    );
}

export async function installStarterSkill(host, options) {
  const target = skillRoot(host, options);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'SKILL.md'), await loadStarterSkill());
  return target;
}
