import * as p from '@clack/prompts';
import { resolve } from 'node:path';
import { CHARACTERS } from './characters.js';
import { applyInit, DEFAULT_SERVER, summarizePlan } from './init-apply.js';

function stopped(value) {
  if (p.isCancel(value)) {
    p.cancel('Ничего не записано.');
    process.exit(0);
  }
  return value;
}

export async function collectPlan({ cwd = process.cwd() } = {}) {
  p.intro('Olimpyx · подключение к городу');

  const serverUrl = String(stopped(await p.text({
    message: 'Сервер',
    initialValue: DEFAULT_SERVER,
    placeholder: DEFAULT_SERVER,
    validate: (value) => {
      try {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol)) return 'Нужен http или https';
      } catch {
        return 'Это не похоже на URL';
      }
    }
  }))).replace(/\/$/, '');

  const mode = stopped(await p.select({
    message: 'Аккаунт владельца',
    options: [
      { value: 'register', label: 'Создать новый', hint: 'email + пароль + имя' },
      { value: 'login', label: 'Войти', hint: 'уже регистрировались на сайте' }
    ]
  }));

  const email = String(stopped(await p.text({
    message: 'Email',
    placeholder: 'you@example.com',
    validate: (value) => /\S+@\S+\.\S+/.test(value) ? undefined : 'Нужен обычный email'
  }))).trim().toLowerCase();

  let displayName;
  if (mode === 'register') {
    displayName = String(stopped(await p.text({
      message: 'Отображаемое имя',
      placeholder: 'Как вас видно в городе',
      validate: (value) => value.trim() ? undefined : 'Имя не должно быть пустым'
    }))).trim();
  }

  const password = String(stopped(await p.password({
    message: 'Пароль',
    validate: (value) => value.length >= 12 ? undefined : 'Не короче 12 символов'
  })));
  if (mode === 'register') {
    const again = String(stopped(await p.password({
      message: 'Пароль ещё раз',
      validate: (value) => value === password ? undefined : 'Пароли не совпали'
    })));
    if (again !== password) {
      p.cancel('Пароли не совпали.');
      process.exit(0);
    }
  }

  const skillScope = stopped(await p.select({
    message: 'Куда поставить стартер-скилл',
    options: [
      { value: 'global', label: 'Глобально', hint: '~/.claude/skills и ~/.agents/skills' },
      { value: 'local', label: 'В проект', hint: 'текущая папка, путь можно поправить' }
    ]
  }));

  let projectPath = cwd;
  if (skillScope === 'local') {
    projectPath = resolve(String(stopped(await p.text({
      message: 'Путь проекта',
      initialValue: cwd,
      hint: 'Enter — оставить текущий'
    }))));
  }

  const hosts = stopped(await p.multiselect({
    message: 'Хосты для скилла',
    options: [
      { value: 'claude', label: 'Claude Code', hint: '.claude/skills' },
      { value: 'codex', label: 'Codex', hint: '.agents/skills' }
    ],
    initialValues: ['claude', 'codex'],
    required: true
  }));

  const characterIds = stopped(await p.groupMultiselect({
    message: 'Базовые персонажи (пробел — выбрать, Enter — дальше)',
    options: {
      IT: CHARACTERS.filter((item) => item.cluster === 'it').map((item) => ({
        value: item.id,
        label: `${item.name} — ${item.role}`
      })),
      'Отрасли': CHARACTERS.filter((item) => item.cluster === 'industry').map((item) => ({
        value: item.id,
        label: `${item.name} — ${item.role}`
      }))
    },
    required: false,
    selectableGroups: false
  })) || [];

  const plan = { serverUrl, mode, email, password, displayName, skillScope, projectPath, hosts, characterIds };
  p.note(summarizePlan(plan), 'Сводка');
  const ok = stopped(await p.confirm({
    message: 'Записать vault, скилл и выбранных агентов?',
    initialValue: true
  }));
  if (!ok) {
    p.cancel('Ничего не записано.');
    process.exit(0);
  }
  return plan;
}

export async function runInit() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('olimpyx init нужен интерактивный терминал. Запустите в обычном терминале, не из пайпа.');
  }
  const plan = await collectPlan();
  const spin = p.spinner();
  const labels = {
    account: plan.mode === 'register' ? 'Регистрируем владельца' : 'Входим',
    vault: 'Шифруем vault',
    catalog: 'Копируем каталог персонажей',
    playbook: 'Пишем playbook',
    skills: 'Ставим стартер-скилл'
  };
  spin.start('Подключаемся…');
  try {
    const result = await applyInit(plan, {
      onProgress: (step) => {
        if (step.startsWith('agent:')) spin.message(`Регистрируем ${step.slice(6)}`);
        else spin.message(labels[step] || step);
      }
    });
    spin.stop('Готово');
    const agentLines = result.enrolled.length
      ? result.enrolled.map((item) => `  ${item.id} → ${item.home}`).join('\n')
      : '  (никого — добавите позже: olimpyx agent add prometheus)';
    p.note(
      [
        `Дом владельца: ${result.home}`,
        `Скилл:`,
        ...result.installedSkills.map((path) => `  ${path}`),
        'Агенты:',
        agentLines,
        '',
        'Дальше: olimpyx status · olimpyx skill'
      ].join('\n'),
      'Что записано'
    );
    p.outro('Пароль больше не нужно класть в файлы проекта.');
  } catch (error) {
    spin.stop('Не вышло');
    throw error;
  }
}
