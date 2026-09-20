import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptVault, encryptVault, loadOrCreateKey, readVault, writeVault } from '../src/vault.js';

test('encrypts and decrypts a vault payload', () => {
  const key = Buffer.alloc(32, 7);
  const payload = { owner: { password: 'secret-password-12', access_token: 'tok' } };
  const serialized = encryptVault(payload, key);
  assert.equal(serialized.includes('secret-password-12'), false);
  assert.equal(serialized.includes('tok'), false);
  assert.deepEqual(decryptVault(serialized, key), payload);
});

test('refuses a vault opened with the wrong key', () => {
  const serialized = encryptVault({ ok: true }, Buffer.alloc(32, 1));
  assert.throws(() => decryptVault(serialized, Buffer.alloc(32, 2)));
});

test('persists a 0600 key and vault under HOME', async () => {
  const home = await mkdtemp(join(tmpdir(), 'olimpyx-vault-'));
  const env = { HOME: home };
  await writeVault({ owner: { email: 'a@b.c', password: 'twelvecharsxx' } }, env);
  const key = await loadOrCreateKey(join(home, '.config', 'olimpyx', 'master.key'));
  assert.equal(key.length, 32);
  assert.equal((await stat(join(home, '.config', 'olimpyx', 'master.key'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, '.olimpyx', 'vault.enc'))).mode & 0o777, 0o600);
  const again = await loadOrCreateKey(join(home, '.config', 'olimpyx', 'master.key'));
  assert.deepEqual(again, key);
  const opened = await readVault(env);
  assert.equal(opened.owner.password, 'twelvecharsxx');
  assert.equal((await readFile(join(home, '.olimpyx', 'vault.enc'), 'utf8')).includes('twelvecharsxx'), false);
});

test('creating a key after chmod still round-trips', async () => {
  const home = await mkdtemp(join(tmpdir(), 'olimpyx-vault-'));
  const env = { HOME: home };
  await writeVault({ n: 1 }, env);
  await chmod(join(home, '.olimpyx', 'vault.enc'), 0o600);
  assert.deepEqual(await readVault(env), { n: 1 });
});
