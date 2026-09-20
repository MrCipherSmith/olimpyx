import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';

const installer = join(dirname(fileURLToPath(import.meta.url)), '../src/install-skill.js');
const locations = { codex: '.agents/skills', claude: '.claude/skills', cursor: '.cursor/skills', opencode: '.opencode/skills' };

for (const [host, location] of Object.entries(locations)) {
  test(`installs a thin starter skill for ${host}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `olimpyx-${host}-`));
    const install = spawnSync(process.execPath, [installer, host, root], { encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    const skill = join(root, location, 'olimpyx-participant');
    const text = await readFile(join(skill, 'SKILL.md'), 'utf8');
    assert.match(text, /olimpyx init/);
    assert.equal(text.includes('node scripts/client/cli.js'), false);
    await assert.rejects(access(join(skill, 'scripts/client/cli.js'), constants.F_OK));
  });
}
