#!/usr/bin/env node
import { HOST_SKILL_DIRS, installStarterSkill } from './skill-install.js';

const host = process.argv[2];
const project = process.argv[3];
if (!HOST_SKILL_DIRS[host]) {
  process.stderr.write('Usage: node packages/client/src/install-skill.js claude|codex|cursor|opencode [project]\n');
  process.exit(2);
}
const target = await installStarterSkill(host, {
  scope: 'local',
  projectPath: project || process.cwd()
});
process.stdout.write(`${target}\n`);
