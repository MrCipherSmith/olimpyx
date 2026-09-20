import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const noFollow = constants.O_NOFOLLOW;
const missing = (error) => error.code === 'ENOENT';

/** Private permanent storage. Filenames are fixed, never selected by model input.
 * Callers serialize read/modify/write operations with withLock().
 */
export class ResidentStore {
  constructor(home, { now = Date.now } = {}) {
    this.root = join(home, 'resident');
    this.now = now;
  }

  async prepare() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.root)).isDirectory()) throw new Error('Resident storage must be a real directory');
    await chmod(this.root, 0o700);
  }

  async syncDirectory() {
    const directory = await open(this.root, constants.O_RDONLY | noFollow);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async read() {
    let file;
    try {
      file = await open(join(this.root, 'state.json'), constants.O_RDONLY | noFollow);
      return JSON.parse(await file.readFile('utf8'));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    } finally { await file?.close(); }
  }

  async save(state) {
    const content = JSON.stringify(state);
    if (content === undefined) throw new Error('State must be JSON serializable');
    await this.prepare();
    const temporary = join(this.root, `.state-${randomUUID()}.tmp`);
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(`${content}\n`);
      await file.sync();
      await file.close();
      file = null;
      await rename(temporary, join(this.root, 'state.json'));
      await this.syncDirectory();
    } finally {
      await file?.close();
      await unlink(temporary).catch((error) => { if (!missing(error)) throw error; });
    }
  }

  async append(record) {
    const content = JSON.stringify(record);
    if (content === undefined) throw new Error('Journal record must be JSON serializable');
    await this.prepare();
    const file = await open(join(this.root, 'memory.jsonl'), constants.O_CREAT | constants.O_RDWR | noFollow, 0o600);
    try {
      await file.chmod(0o600);
      let end = (await file.stat()).size;
      // A newline commits a record. Remove only a torn final record before appending.
      const buffer = Buffer.alloc(8192);
      let position = end;
      while (position > 0) {
        const start = Math.max(0, position - buffer.length);
        const { bytesRead } = await file.read(buffer, 0, position - start, start);
        const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
        if (newline >= 0) { end = start + newline + 1; break; }
        position = start;
        end = start;
      }
      await file.truncate(end);
      const bytes = Buffer.from(`${content}\n`);
      let written = 0;
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, end + written);
        if (!result.bytesWritten) throw new Error('Journal write made no progress');
        written += result.bytesWritten;
      }
      await file.sync();
    } finally { await file.close(); }
    await this.syncDirectory();
  }

  async readRecent(limit = 5, maxChars = 6000) {
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(maxChars) || maxChars < 0 || maxChars > 1_000_000) {
      throw new Error('Invalid recent-memory bounds');
    }
    if (!limit || !maxChars) return [];
    let file;
    try {
      file = await open(join(this.root, 'memory.jsonl'), constants.O_RDONLY | noFollow);
      const size = (await file.stat()).size;
      const start = Math.max(0, size - (maxChars * 4 + 8));
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (start) text = text.slice(text.indexOf('\n') + 1);
      const lines = text.split('\n');
      lines.pop(); // Ignore an incomplete final record, including a partial JSON token.
      const records = [];
      let used = 0;
      for (let index = lines.length - 1; index >= 0 && records.length < limit; index -= 1) {
        const line = lines[index];
        if (used + line.length + 1 > maxChars) break;
        records.unshift(JSON.parse(line));
        used += line.length + 1;
      }
      return records;
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    } finally { await file?.close(); }
  }

  async withLock(callback) {
    await this.prepare();
    const guard = join(this.root, '.lock-acquisition');
    const path = join(this.root, 'lock.json');
    const owner = { token: randomUUID(), pid: process.pid, hostname: hostname(), createdAt: this.now() };
    try { await mkdir(guard, { mode: 0o700 }); } catch (error) {
      if (error.code === 'EEXIST') throw new Error('Resident lock acquisition is busy; stale acquisition guards require manual inspection');
      throw error;
    }
    try {
      let existing;
      try { existing = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (!missing(error)) throw error; }
      if (existing) {
        if (existing.hostname !== hostname() || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || typeof existing.token !== 'string') {
          throw new Error('Resident lock owner cannot be safely verified');
        }
        let dead = false;
        try { process.kill(existing.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
        if (!dead) throw new Error('Resident operation is already active');
        await unlink(path);
      }
      const lock = await open(path, 'wx', 0o600);
      try { await lock.writeFile(JSON.stringify(owner)); await lock.sync(); } finally { await lock.close(); }
      await this.syncDirectory();
    } finally { await rmdir(guard); }
    try { return await callback(); } finally {
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (current.token === owner.token) {
        await unlink(path);
        await this.syncDirectory();
      }
    }
  }
}
