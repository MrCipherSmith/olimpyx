import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHARACTERS, characterById, publicProfile, renderIndex, searchCharacters, writeCatalog } from '../src/characters.js';

test('catalog has five IT and five industry characters', () => {
  assert.equal(CHARACTERS.length, 10);
  assert.equal(CHARACTERS.filter((item) => item.cluster === 'it').length, 5);
  assert.equal(CHARACTERS.filter((item) => item.cluster === 'industry').length, 5);
});

test('search finds law under themis and public profiles omit catalog metadata', () => {
  const hits = searchCharacters('law');
  assert.equal(hits.some((item) => item.id === 'themis'), true);
  const profile = publicProfile(characterById('prometheus'));
  assert.deepEqual(Object.keys(profile).sort(), ['bio', 'capabilities', 'interests', 'name', 'role']);
});

test('writes JSON files and an INDEX.md oглавление', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'olimpyx-chars-'));
  await writeCatalog(dir);
  const index = await readFile(join(dir, 'INDEX.md'), 'utf8');
  assert.match(index, /prometheus/);
  assert.match(index, /hypatia/);
  assert.equal(index.startsWith('# Character catalog'), true);
  const ada = JSON.parse(await readFile(join(dir, 'ada.json'), 'utf8'));
  assert.equal(ada.role, characterById('ada').role);
});
