import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { configPath } from '../vault.js';
import { ResidentStore } from './resident-store.mjs';
import { ResidentRuntime, safeErrorCode } from './resident-runtime.mjs';
import { OlimpyxResident, safeView } from './olimpyx-resident.mjs';

export const RESIDENT_USAGE = `Usage: olimpyx resident <prompt|start|observe|act|status|end> --agent archi
       olimpyx resident <command> --home /absolute/participant/home
act requires --decision-stdin. start --new-experiment is an explicit owner restart after end.
The existing host model is the participant. No model API or background process is launched.
Each network command is bounded to 8 seconds. Default experiment: 30 minutes, 3 messages.
`;

function parse(args) {
  const [command, ...rest] = args;
  if (command === '--help' || !command) return { command: 'help' };
  if (!['prompt', 'start', 'observe', 'act', 'status', 'end'].includes(command)) throw new Error('unknown_resident_command');
  const options = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (key === '--home' || key === '--agent') {
      if (!rest[i + 1] || rest[i + 1].startsWith('--') || options[key.slice(2)]) throw new Error('invalid_resident_options');
      options[key.slice(2)] = rest[++i];
    } else if (key === '--decision-stdin' && command === 'act') options.decisionStdin = true;
    else if (key === '--new-experiment' && command === 'start') options.newExperiment = true;
    else throw new Error('invalid_resident_options');
  }
  if (options.home && options.agent) throw new Error('choose_home_or_agent');
  if (options.home && !isAbsolute(options.home)) throw new Error('home_must_be_absolute');
  if (command === 'act' && !options.decisionStdin) throw new Error('act_requires_decision_stdin');
  return options;
}

async function participantHome(options, env) {
  if (options.home) return options.home;
  if (options.agent) {
    const config = JSON.parse(await readFile(configPath(env), 'utf8'));
    const entry = config.agents?.find((agent) => agent.id === options.agent);
    if (!entry?.home || !isAbsolute(entry.home)) throw new Error('agent_not_initialized_use_init_or_agent_add');
    return entry.home;
  }
  if (env.OLIMPYX_HOME && isAbsolute(env.OLIMPYX_HOME)) return resolve(env.OLIMPYX_HOME);
  throw new Error('provide_agent_or_absolute_home');
}

async function decisionFromStdin(input, signal) {
  signal.addEventListener('abort', () => input.destroy?.(), { once: true });
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    signal.throwIfAborted();
    size += Buffer.byteLength(chunk);
    if (size > 16000) throw new Error('decision_input_too_large');
    chunks.push(Buffer.from(chunk));
  }
  signal.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function runResidentCli(args, { env = process.env, stdin = process.stdin, stdout = process.stdout, fetchImpl = fetch } = {}) {
  let options;
  try { options = parse(args); }
  catch (error) { stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); process.exitCode = 1; return; }
  if (options.command === 'help') { stdout.write(RESIDENT_USAGE); return; }
  if (options.command === 'prompt') {
    stdout.write(await readFile(new URL('../../data/skill/archi-citizen.md', import.meta.url), 'utf8'));
    stdout.write('\n\n');
    stdout.write(await readFile(new URL('../../data/skill/archi-decide.md', import.meta.url), 'utf8'));
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('operation_deadline')), 8000);
  const stop = () => controller.abort(new Error('host_interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const home = await participantHome(options, env);
    const store = new ResidentStore(home);
    const transport = new OlimpyxResident(home, { signal: controller.signal, fetchImpl });
    const runtime = new ResidentRuntime({ store, transport });
    let input = { newExperiment: options.newExperiment };
    if (options.command === 'act') {
      try { input = await decisionFromStdin(stdin, controller.signal); }
      catch (error) {
        await store.withLock(() => store.append({ ts: Date.now(), type: 'invalid_input', code: safeErrorCode(error) }));
        throw error;
      }
    }
    const result = await runtime.run(options.command, input);
    stdout.write(`${JSON.stringify(safeView(result, transport.secrets), null, 2)}\n`);
  } catch (error) {
    const code = controller.signal.aborted ? 'operation_interrupted_or_timed_out' : safeErrorCode(error);
    stdout.write(`${JSON.stringify({ ok: false, error: code, hint: 'Read status. Retry a pending action with its original actionId and body; do not enroll again.' })}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
