import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ResidentStore } from '../src/resident/resident-store.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'resident-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return new ResidentStore(home);
}

test('state persists atomically with private file and directory modes', async (t) => {
  const store = await fixture(t);
  assert.equal(await store.read(), null);
  await store.save({ identity: 'archi', turn: 1 });
  await store.save({ identity: 'archi', turn: 2 });
  assert.deepEqual(await store.read(), { identity: 'archi', turn: 2 });
  assert.equal((await stat(store.root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(store.root, 'state.json'))).mode & 0o777, 0o600);
});

test('malformed state fails closed instead of resetting identity', async (t) => {
  const store = await fixture(t);
  await store.save({});
  await writeFile(join(store.root, 'state.json'), '{');
  await assert.rejects(store.read(), SyntaxError);
});

test('concurrent operations fail; callback failure releases its lock', async (t) => {
  const store = await fixture(t);
  await assert.rejects(store.withLock(async () => {
    await assert.rejects(store.withLock(() => {}), /already active/);
    throw new Error('callback failed');
  }), /callback failed/);
  assert.equal(await store.withLock(() => 42), 42);
});

test('dead same-host owner is recovered; foreign owner fails conservatively', async (t) => {
  const store = await fixture(t);
  await store.prepare();
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  await once(child, 'exit');
  await writeFile(join(store.root, 'lock.json'), JSON.stringify({ pid, hostname: hostname(), token: 'dead' }));
  assert.equal(await store.withLock(() => 'recovered'), 'recovered');
  await writeFile(join(store.root, 'lock.json'), JSON.stringify({ pid, hostname: 'another-machine', token: 'foreign' }));
  await assert.rejects(store.withLock(() => {}), /cannot be safely verified/);
});

test('a distinct process cannot acquire an active owner lock', async (t) => {
  const store = await fixture(t);
  await store.withLock(async () => {
    const source = `import { ResidentStore } from ${JSON.stringify(new URL('../src/resident/resident-store.mjs', import.meta.url).href)}; await new ResidentStore(${JSON.stringify(join(store.root, '..'))}).withLock(() => {});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
  });
});

test('release never deletes another owner token', async (t) => {
  const store = await fixture(t);
  await store.withLock(async () => {
    await writeFile(join(store.root, 'lock.json'), JSON.stringify({ token: 'replacement' }));
  });
  assert.equal(JSON.parse(await readFile(join(store.root, 'lock.json'), 'utf8')).token, 'replacement');
});

test('recent memory bounds output and repairs torn append without corrupting history', async (t) => {
  const store = await fixture(t);
  assert.deepEqual(await store.readRecent(), []);
  for (let index = 0; index < 15; index += 1) await store.append({ index, note: 'memory' });
  assert.equal((await stat(join(store.root, 'memory.jsonl'))).mode & 0o777, 0o600);
  assert.deepEqual((await store.readRecent(3)).map((record) => record.index), [12, 13, 14]);
  const bounded = await store.readRecent(100, 65);
  assert.ok(bounded.reduce((sum, record) => sum + JSON.stringify(record).length + 1, 0) <= 65);
  await appendFile(join(store.root, 'memory.jsonl'), '{"torn":');
  assert.equal((await store.readRecent(1))[0].index, 14);
  await store.append({ index: 15 });
  assert.deepEqual(await store.readRecent(1), [{ index: 15 }]);
  const lines = (await readFile(join(store.root, 'memory.jsonl'), 'utf8')).trimEnd().split('\n');
  assert.equal(lines.length, 16);
  for (const line of lines) JSON.parse(line);
});

test('bounded tail skips a large preceding record and rejects committed corruption', async (t) => {
  const store = await fixture(t);
  await store.append({ large: 'x'.repeat(100000) });
  await store.append({ newest: '💡' });
  assert.deepEqual(await store.readRecent(5, 100), [{ newest: '💡' }]);
  await appendFile(join(store.root, 'memory.jsonl'), 'broken\n');
  await assert.rejects(store.readRecent(), SyntaxError);
  await assert.rejects(store.readRecent(1, Infinity), /Invalid/);
});
