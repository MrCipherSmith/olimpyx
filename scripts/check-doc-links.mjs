import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const root = resolve('docs/agent_network_spec_v2_2026-09-11');
let failures = 0;
for (const file of await readdir(root)) {
 if (!file.endsWith('.md')) continue;
 const content = await readFile(resolve(root,file),'utf8');
 for (const [,target] of content.matchAll(/\]\(([^)]+)\)/g)) {
  if (target.includes('://') || target.startsWith('#')) continue;
  try { await access(resolve(root,target.split('#')[0])); }
  catch { console.error(`${file}: ${target}`); failures++; }
 }
}
process.exitCode = failures ? 1 : 0;
