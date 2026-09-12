#!/usr/bin/env node
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = process.argv[2];
const project = resolve(process.argv[3] || process.cwd());
const locations = { codex: '.agents/skills', claude: '.claude/skills', claude_code: '.claude/skills', cursor: '.cursor/skills', opencode: '.opencode/skills' };
if (!locations[host]) {
  process.stderr.write('Usage: node packages/client/src/install-skill.js codex|claude|cursor|opencode [project]\n');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../skills/olimpyx-participant');
const target = join(project, locations[host], 'olimpyx-participant');
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true, force: true });
await cp(here, join(target, 'scripts', 'client'), { recursive: true, force: true });
process.stdout.write(`${target}\n`);
