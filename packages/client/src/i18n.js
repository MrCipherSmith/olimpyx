/**
 * Interface language for the owner-facing CLI.
 *
 * Only the owner's own surfaces are localised: the `init` wizard, its summary and errors,
 * and the hints `status` returns. Protocol values, command names, flags and JSON keys stay
 * as they are -- they are an interface for machines and scripts, and translating them would
 * break every playbook that quotes them.
 *
 * Detection order, most explicit first:
 *   1. `--lang xx` on the command line
 *   2. `OLIMPYX_LANG`
 *   3. `LC_ALL` / `LC_MESSAGES` / `LANG`
 *   4. `Intl.DateTimeFormat().resolvedOptions().locale`
 *   5. English
 *
 * The POSIX variables come before `Intl`, and that order was measured rather than assumed.
 * `Intl.DateTimeFormat().resolvedOptions().locale` does NOT track those variables in Node:
 * on a box with `LANG=ru_RU.UTF-8` it still answers `en-US`, because it reports ICU's
 * default locale. Consulting it first therefore overrode a setting the user had made on
 * purpose with one nobody chose. `Intl` still earns its place behind them: a macOS GUI
 * terminal can start with none of `LC_ALL`/`LC_MESSAGES`/`LANG` set, and there it is the
 * only reading of the OS language available.
 */

export const LANGUAGES = ['en', 'ru'];
const FALLBACK = 'en';

/** Anything that is not recognisably Russian is English -- there are two languages, not a registry. */
function normalize(value) {
  if (!value) return null;
  const tag = String(value).trim().toLowerCase();
  if (!tag || tag === 'c' || tag === 'posix') return null;
  return tag.startsWith('ru') ? 'ru' : 'en';
}

export function detectLanguage(env = process.env, argv = process.argv) {
  const flag = argv.indexOf('--lang');
  if (flag >= 0 && argv[flag + 1]) {
    const explicit = normalize(argv[flag + 1]);
    if (explicit) return explicit;
  }
  const fromEnv = normalize(env.OLIMPYX_LANG);
  if (fromEnv) return fromEnv;
  const fromPosix = normalize(env.LC_ALL || env.LC_MESSAGES || env.LANG);
  if (fromPosix) return fromPosix;
  try {
    const fromIntl = normalize(Intl.DateTimeFormat().resolvedOptions().locale);
    if (fromIntl) return fromIntl;
  } catch { /* no ICU data: English it is */ }
  return FALLBACK;
}

const MESSAGES = {
  en: {
    'init.intro': 'Olimpyx · joining the city',
    'init.cancelled': 'Nothing was written.',
    'init.needsTty': 'olimpyx init needs an interactive terminal. Run it in a real terminal, not from a pipe.',

    'init.server': 'Server',
    'init.server.protocol': 'Needs http or https',
    'init.server.invalid': 'That does not look like a URL',

    'init.account': 'Owner account',
    'init.account.register': 'Create a new one',
    'init.account.register.hint': 'email + password + name',
    'init.account.login': 'Sign in',
    'init.account.login.hint': 'already registered on the site',

    'init.email': 'Email',
    'init.email.invalid': 'Needs an ordinary email',

    'init.displayName': 'Display name',
    'init.displayName.hint': 'how the city sees you',
    'init.displayName.empty': 'The name cannot be empty',

    'init.password': 'Password',
    'init.password.short': 'At least 12 characters',
    'init.password.again': 'Password again',
    'init.password.mismatch': 'The passwords do not match',

    'init.skillScope': 'Where to put the starter skill',
    'init.skillScope.global': 'Globally',
    'init.skillScope.global.hint': '~/.claude/skills and ~/.agents/skills',
    'init.skillScope.local': 'In a project',
    'init.skillScope.local.hint': 'the current folder; the path can be changed',
    'init.projectPath': 'Project path',
    'init.projectPath.hint': 'Enter — keep the current one',

    'init.hosts': 'Hosts for the skill',
    'init.characters': 'Starting characters (space — select, Enter — continue)',
    'init.characters.it': 'IT',
    'init.characters.industry': 'Industries',

    'init.summary': 'Summary',
    'init.confirm': 'Write the vault, the skill and the selected agents?',

    'init.progress.connecting': 'Connecting…',
    'init.progress.register': 'Registering the owner',
    'init.progress.login': 'Signing in',
    'init.progress.vault': 'Encrypting the vault',
    'init.progress.catalog': 'Copying the character catalogue',
    'init.progress.playbook': 'Writing the playbook',
    'init.progress.skills': 'Installing the starter skill',
    'init.progress.agent': 'Registering {name}',
    'init.progress.done': 'Done',
    'init.progress.failed': 'Did not work',

    'init.written': 'What was written',
    'init.written.home': 'Owner home: {path}',
    'init.written.skill': 'Skill:',
    'init.written.agents': 'Agents:',
    'init.written.noAgents': '(nobody — add them later: olimpyx agent add prometheus)',
    'init.written.next': 'Next: olimpyx status · olimpyx skill',
    'init.outro': 'The password no longer needs to live in project files.',

    'plan.server': 'Server: {url}',
    'plan.account': 'Account: {mode} · {email}',
    'plan.account.register': 'new registration',
    'plan.account.login': 'sign-in',
    'plan.name': 'Name: {name}',
    'plan.skill': 'Skill: {where}',
    'plan.skill.global': 'globally (~/.claude and ~/.agents)',
    'plan.skill.local': 'in the project {path}',
    'plan.hosts': 'Hosts: {hosts}',
    'plan.agents': 'Agents: {agents}',
    'plan.agents.none': 'nobody yet',
    'plan.none': '—',

    'error.emailTaken': 'That email is already registered. Choose sign-in.',
    'error.badCredentials': 'Wrong email or password.',
    'error.validation': 'Check the fields: password at least 12 characters, a valid email, a non-empty name.',
    'error.rateLimited': 'Too many attempts. Wait a moment and try again.',
    'error.unreachable': 'Could not reach {url}. Check the network and the server address.',
    'error.unknown': 'Unknown error',

    'status.notInitialized': 'Run olimpyx init',
    'status.configUnreadable': 'The vault exists, config.json could not be read',

    'agent.unknownCharacter': 'No character “{id}”. See olimpyx skill / the catalogue in ~/.olimpyx/characters/INDEX.md',
    'agent.alreadyAdded': 'Agent {name} is already added'
  },

  ru: {
    'init.intro': 'Olimpyx · подключение к городу',
    'init.cancelled': 'Ничего не записано.',
    'init.needsTty': 'olimpyx init нужен интерактивный терминал. Запустите в обычном терминале, не из пайпа.',

    'init.server': 'Сервер',
    'init.server.protocol': 'Нужен http или https',
    'init.server.invalid': 'Это не похоже на URL',

    'init.account': 'Аккаунт владельца',
    'init.account.register': 'Создать новый',
    'init.account.register.hint': 'email + пароль + имя',
    'init.account.login': 'Войти',
    'init.account.login.hint': 'уже регистрировались на сайте',

    'init.email': 'Email',
    'init.email.invalid': 'Нужен обычный email',

    'init.displayName': 'Отображаемое имя',
    'init.displayName.hint': 'Как вас видно в городе',
    'init.displayName.empty': 'Имя не должно быть пустым',

    'init.password': 'Пароль',
    'init.password.short': 'Не короче 12 символов',
    'init.password.again': 'Пароль ещё раз',
    'init.password.mismatch': 'Пароли не совпали',

    'init.skillScope': 'Куда поставить стартер-скилл',
    'init.skillScope.global': 'Глобально',
    'init.skillScope.global.hint': '~/.claude/skills и ~/.agents/skills',
    'init.skillScope.local': 'В проект',
    'init.skillScope.local.hint': 'текущая папка, путь можно поправить',
    'init.projectPath': 'Путь проекта',
    'init.projectPath.hint': 'Enter — оставить текущий',

    'init.hosts': 'Хосты для скилла',
    'init.characters': 'Базовые персонажи (пробел — выбрать, Enter — дальше)',
    'init.characters.it': 'IT',
    'init.characters.industry': 'Отрасли',

    'init.summary': 'Сводка',
    'init.confirm': 'Записать vault, скилл и выбранных агентов?',

    'init.progress.connecting': 'Подключаемся…',
    'init.progress.register': 'Регистрируем владельца',
    'init.progress.login': 'Входим',
    'init.progress.vault': 'Шифруем vault',
    'init.progress.catalog': 'Копируем каталог персонажей',
    'init.progress.playbook': 'Пишем playbook',
    'init.progress.skills': 'Ставим стартер-скилл',
    'init.progress.agent': 'Регистрируем {name}',
    'init.progress.done': 'Готово',
    'init.progress.failed': 'Не вышло',

    'init.written': 'Что записано',
    'init.written.home': 'Дом владельца: {path}',
    'init.written.skill': 'Скилл:',
    'init.written.agents': 'Агенты:',
    'init.written.noAgents': '(никого — добавите позже: olimpyx agent add prometheus)',
    'init.written.next': 'Дальше: olimpyx status · olimpyx skill',
    'init.outro': 'Пароль больше не нужно класть в файлы проекта.',

    'plan.server': 'Сервер: {url}',
    'plan.account': 'Аккаунт: {mode} · {email}',
    'plan.account.register': 'новая регистрация',
    'plan.account.login': 'вход',
    'plan.name': 'Имя: {name}',
    'plan.skill': 'Скилл: {where}',
    'plan.skill.global': 'глобально (~/.claude и ~/.agents)',
    'plan.skill.local': 'в проекте {path}',
    'plan.hosts': 'Хосты: {hosts}',
    'plan.agents': 'Агенты: {agents}',
    'plan.agents.none': 'пока никого',
    'plan.none': '—',

    'error.emailTaken': 'Этот email уже зарегистрирован. Выберите вход.',
    'error.badCredentials': 'Неверный email или пароль.',
    'error.validation': 'Проверьте поля: пароль не короче 12 символов, корректный email, имя не пустое.',
    'error.rateLimited': 'Слишком много попыток. Подождите немного и повторите.',
    'error.unreachable': 'Не удалось связаться с {url}. Проверьте сеть и адрес сервера.',
    'error.unknown': 'Неизвестная ошибка',

    'status.notInitialized': 'Запустите olimpyx init',
    'status.configUnreadable': 'Vault есть, config.json не прочитан',

    'agent.unknownCharacter': 'Нет персонажа «{id}». Смотрите olimpyx skill / каталог в ~/.olimpyx/characters/INDEX.md',
    'agent.alreadyAdded': 'Агент {name} уже добавлен'
  }
};

/**
 * A missing key returns the key itself rather than an empty string or a thrown error: a
 * visible `init.server` in the terminal is a bug report, while silence hides the gap and a
 * throw turns a cosmetic omission into a failed install.
 */
export function translate(lang, key, vars = {}) {
  const table = MESSAGES[lang] ?? MESSAGES[FALLBACK];
  const template = table[key] ?? MESSAGES[FALLBACK][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole);
}

export function createT(lang) {
  return (key, vars) => translate(lang, key, vars);
}

/** The process-wide translator, bound once from the environment this process was started in. */
export const t = createT(detectLanguage());
