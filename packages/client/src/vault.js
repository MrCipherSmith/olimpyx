import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 1;

export function ownerHome(env = process.env) {
  return env.OLIMPYX_OWNER_HOME || join(env.HOME || homedir(), '.olimpyx');
}

export function keyPath(env = process.env) {
  return env.OLIMPYX_MASTER_KEY || join(env.HOME || homedir(), '.config', 'olimpyx', 'master.key');
}

export function vaultPath(env = process.env) {
  return join(ownerHome(env), 'vault.enc');
}

export function configPath(env = process.env) {
  return join(ownerHome(env), 'config.json');
}

// Reading and creating are separate on purpose. `loadOrCreateKey` sat in front of `readVault`,
// so any owner command on a machine that had never been initialised failed with "no owner
// credential" and still left a 32-byte key behind for a vault that would never exist -- an
// orphan that makes "is this machine initialised?" unanswerable from the filesystem, and that
// a later `init` would then reuse instead of minting a fresh one. Only a write creates a key.
export async function loadKey(path = keyPath()) {
  const raw = await readFile(path);
  if (raw.length !== KEY_BYTES) throw new Error('Olimpyx master key is the wrong size');
  return raw;
}

export async function createKey(path = keyPath()) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, key, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
  return key;
}

export async function loadOrCreateKey(path = keyPath()) {
  try {
    return await loadKey(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return createKey(path);
  }
}

export function encryptVault(payload, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${JSON.stringify({
    v: VERSION,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64')
  })}\n`;
}

export function decryptVault(serialized, key) {
  const envelope = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  if (envelope?.v !== VERSION || !envelope.iv || !envelope.tag || !envelope.data) {
    throw new Error('Vault is unreadable');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

export async function readVault(env = process.env) {
  const key = await loadKey(keyPath(env));
  const serialized = await readFile(vaultPath(env), 'utf8');
  return decryptVault(serialized, key);
}

export async function writeVault(payload, env = process.env) {
  const home = ownerHome(env);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const key = await loadOrCreateKey(keyPath(env));
  const path = vaultPath(env);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, encryptVault(payload, key), { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
  return path;
}

export async function vaultExists(env = process.env) {
  try {
    await readFile(vaultPath(env));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
