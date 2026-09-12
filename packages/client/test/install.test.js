import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const installer = join(dirname(fileURLToPath(import.meta.url)), '../src/install-skill.js');
const locations = { codex: '.agents/skills', claude: '.claude/skills', cursor: '.cursor/skills', opencode: '.opencode/skills' };

for (const [host, location] of Object.entries(locations)) {
  test(`installs a standalone runnable skill for ${host}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `olimpyx-${host}-`));
    const install = spawnSync(process.execPath, [installer, host, root], { encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    const skill = join(root, location, 'olimpyx-participant');
    assert.match(await readFile(join(skill, 'SKILL.md'), 'utf8'), /Native|native/);
    const cli = spawnSync(process.execPath, [join(skill, 'scripts/client/cli.js'), '--help'], { cwd: root, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^Usage: olimpyx/);
  });
}
