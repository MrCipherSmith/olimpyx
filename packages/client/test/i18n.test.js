import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { LANGUAGES, createT, detectLanguage, translate } from '../src/i18n.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

function run(args, { cwd, env = {} }) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
    child.stdin.end('');
  });
}

test('the explicit sources win in order: flag, then OLIMPYX_LANG, then the POSIX locale', () => {
  assert.equal(detectLanguage({ OLIMPYX_LANG: 'en', LANG: 'en_US.UTF-8' }, ['node', 'cli', '--lang', 'ru']), 'ru');
  assert.equal(detectLanguage({ LANG: 'en_US.UTF-8' }, ['node', 'cli', '--lang', 'RU']), 'ru', 'the tag is case-insensitive');
  assert.equal(detectLanguage({ OLIMPYX_LANG: 'ru', LANG: 'en_US.UTF-8' }, ['node', 'cli']), 'ru');
  assert.equal(detectLanguage({ LC_ALL: 'ru_RU.UTF-8', LANG: 'en_US.UTF-8' }, ['node', 'cli']), 'ru', 'LC_ALL outranks LANG');
  assert.equal(detectLanguage({ LC_MESSAGES: 'ru_RU.UTF-8' }, ['node', 'cli']), 'ru');
});

// This is the case that made the order what it is. Intl.DateTimeFormat() does not read
// LANG in Node -- it reports ICU's default, which is en-US on a machine whose owner has
// deliberately set LANG=ru_RU.UTF-8. Consulting Intl first silently overrode that choice.
test('a POSIX locale is honoured even though Intl disagrees with it', () => {
  assert.equal(detectLanguage({ LANG: 'ru_RU.UTF-8' }, ['node', 'cli']), 'ru');
});

test('locales that carry no language fall through instead of being read as English', () => {
  // `C` and `POSIX` mean "no localisation", not "American English". Treating them as a
  // language would stop the fallback chain before Intl ever gets a turn, which is exactly
  // where a macOS GUI terminal's setting lives.
  assert.equal(detectLanguage({ LANG: 'C', OLIMPYX_LANG: 'ru' }, ['node', 'cli']), 'ru');
  assert.equal(detectLanguage({ LANG: 'POSIX', OLIMPYX_LANG: 'ru' }, ['node', 'cli']), 'ru');
  assert.equal(detectLanguage({ LANG: '', OLIMPYX_LANG: 'ru' }, ['node', 'cli']), 'ru');
  assert.equal(detectLanguage({ OLIMPYX_LANG: '  ', LANG: 'ru_RU.UTF-8' }, ['node', 'cli']), 'ru');
});

test('any language that is not Russian resolves to English', () => {
  for (const tag of ['de_DE.UTF-8', 'fr-FR', 'ja_JP.UTF-8', 'en_GB.UTF-8', 'zh-Hans']) {
    assert.equal(detectLanguage({ LANG: tag }, ['node', 'cli']), 'en', tag);
  }
  assert.equal(detectLanguage({ LANG: 'ru' }, ['node', 'cli']), 'ru');
  assert.equal(detectLanguage({ LANG: 'ru-RU' }, ['node', 'cli']), 'ru');
});

test('a --lang with no value does not consume the fallback chain', () => {
  assert.equal(detectLanguage({ OLIMPYX_LANG: 'ru' }, ['node', 'cli', '--lang']), 'ru');
  assert.equal(detectLanguage({ OLIMPYX_LANG: 'ru' }, ['node', 'cli', '--lang', '']), 'ru');
});

test('both dictionaries carry exactly the same keys', () => {
  // A key present in one language and missing in the other is the defect this catches:
  // the reader gets a raw `init.server` in the terminal, and nothing else notices.
  const keys = LANGUAGES.map((lang) => ({ lang, keys: Object.keys(dictionaryOf(lang)).sort() }));
  const [first, ...rest] = keys;
  for (const other of rest) {
    assert.deepEqual(other.keys, first.keys, `${other.lang} and ${first.lang} disagree on keys`);
  }
  assert.ok(first.keys.length > 40, 'the dictionary should not have silently emptied');
});

function dictionaryOf(lang) {
  // translate() is the only door into the tables, so the key set is recovered through it:
  // every key resolves to something other than itself in its own language.
  const probes = Object.keys(EXPECTED_KEYS);
  const found = {};
  for (const key of probes) {
    const value = translate(lang, key);
    if (value !== key) found[key] = value;
  }
  return found;
}

// The key list is written down rather than derived, so that deleting a key from BOTH
// dictionaries still fails this test instead of quietly shrinking the expectation.
const EXPECTED_KEYS = Object.fromEntries([
  'init.intro', 'init.cancelled', 'init.needsTty',
  'init.server', 'init.server.protocol', 'init.server.invalid',
  'init.account', 'init.account.register', 'init.account.register.hint',
  'init.account.login', 'init.account.login.hint',
  'init.email', 'init.email.invalid',
  'init.displayName', 'init.displayName.hint', 'init.displayName.empty',
  'init.password', 'init.password.short', 'init.password.again', 'init.password.mismatch',
  'init.skillScope', 'init.skillScope.global', 'init.skillScope.global.hint',
  'init.skillScope.local', 'init.skillScope.local.hint',
  'init.projectPath', 'init.projectPath.hint',
  'init.hosts', 'init.characters', 'init.characters.it', 'init.characters.industry',
  'init.summary', 'init.confirm',
  'init.progress.connecting', 'init.progress.register', 'init.progress.login',
  'init.progress.vault', 'init.progress.catalog', 'init.progress.playbook',
  'init.progress.skills', 'init.progress.agent', 'init.progress.done', 'init.progress.failed',
  'init.written', 'init.written.home', 'init.written.skill', 'init.written.agents',
  'init.written.noAgents', 'init.written.next', 'init.outro',
  'plan.server', 'plan.account', 'plan.account.register', 'plan.account.login',
  'plan.name', 'plan.skill', 'plan.skill.global', 'plan.skill.local',
  'plan.hosts', 'plan.agents', 'plan.agents.none', 'plan.none',
  'error.emailTaken', 'error.badCredentials', 'error.validation', 'error.rateLimited',
  'error.unreachable', 'error.unknown',
  'status.notInitialized', 'status.configUnreadable',
  'agent.unknownCharacter', 'agent.alreadyAdded'
].map((key) => [key, true]));

test('every key used by the code resolves in every language', () => {
  for (const lang of LANGUAGES) {
    for (const key of Object.keys(EXPECTED_KEYS)) {
      assert.notEqual(translate(lang, key), key, `${lang} is missing ${key}`);
    }
  }
});

test('placeholders are filled, and an unknown placeholder is left visible', () => {
  assert.equal(translate('en', 'plan.server', { url: 'https://x' }), 'Server: https://x');
  assert.equal(translate('ru', 'plan.server', { url: 'https://x' }), 'Сервер: https://x');
  // Left as-is rather than replaced with "undefined": the literal {url} names the variable
  // that was not supplied, which is what a reader needs to fix it.
  assert.match(translate('en', 'plan.server', {}), /\{url\}/);
});

test('an unknown key returns itself instead of throwing or vanishing', () => {
  assert.equal(translate('en', 'no.such.key'), 'no.such.key');
  assert.equal(createT('ru')('no.such.key'), 'no.such.key');
});

test('an unknown language falls back to English rather than to empty strings', () => {
  assert.equal(translate('de', 'status.notInitialized'), translate('en', 'status.notInitialized'));
});

test('the CLI speaks the language the environment asks for', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'olimpyx-i18n-'));
  const base = { PATH: process.env.PATH, HOME: cwd, OLIMPYX_OWNER_HOME: join(cwd, 'owner'), OLIMPYX_HOME: join(cwd, '.olimpyx') };

  const english = await run(['status'], { cwd, env: { ...base, OLIMPYX_LANG: 'en' } });
  assert.equal(english.status, 0);
  assert.match(JSON.parse(english.stdout).hint, /Run olimpyx init/);

  const russian = await run(['status'], { cwd, env: { ...base, OLIMPYX_LANG: 'ru' } });
  assert.equal(russian.status, 0);
  assert.match(JSON.parse(russian.stdout).hint, /Запустите olimpyx init/);

  // LANG alone drives it too -- the path a user gets without knowing OLIMPYX_LANG exists.
  const viaLang = await run(['status'], { cwd, env: { ...base, LANG: 'ru_RU.UTF-8' } });
  assert.match(JSON.parse(viaLang.stdout).hint, /Запустите olimpyx init/);
});

test('init refuses a non-interactive terminal in the requested language', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'olimpyx-i18n-tty-'));
  const base = { PATH: process.env.PATH, HOME: cwd, OLIMPYX_OWNER_HOME: join(cwd, 'owner'), OLIMPYX_HOME: join(cwd, '.olimpyx') };

  const english = await run(['init'], { cwd, env: { ...base, OLIMPYX_LANG: 'en' } });
  assert.equal(english.status, 1);
  assert.match(english.stderr, /needs an interactive terminal/);

  const russian = await run(['init'], { cwd, env: { ...base, OLIMPYX_LANG: 'ru' } });
  assert.equal(russian.status, 1);
  assert.match(russian.stderr, /нужен интерактивный терминал/);
});
