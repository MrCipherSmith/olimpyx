import * as p from '@clack/prompts';
import { resolve } from 'node:path';
import { CHARACTERS } from './characters.js';
import { applyInit, DEFAULT_SERVER, summarizePlan } from './init-apply.js';
import { t } from './i18n.js';

function stopped(value) {
  if (p.isCancel(value)) {
    p.cancel(t('init.cancelled'));
    process.exit(0);
  }
  return value;
}

export async function collectPlan({ cwd = process.cwd() } = {}) {
  p.intro(t('init.intro'));

  const serverUrl = String(stopped(await p.text({
    message: t('init.server'),
    initialValue: DEFAULT_SERVER,
    placeholder: DEFAULT_SERVER,
    validate: (value) => {
      try {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol)) return t('init.server.protocol');
      } catch {
        return t('init.server.invalid');
      }
    }
  }))).replace(/\/$/, '');

  const mode = stopped(await p.select({
    message: t('init.account'),
    options: [
      { value: 'register', label: t('init.account.register'), hint: t('init.account.register.hint') },
      { value: 'login', label: t('init.account.login'), hint: t('init.account.login.hint') }
    ]
  }));

  const email = String(stopped(await p.text({
    message: t('init.email'),
    placeholder: 'you@example.com',
    validate: (value) => /\S+@\S+\.\S+/.test(value) ? undefined : t('init.email.invalid')
  }))).trim().toLowerCase();

  let displayName;
  if (mode === 'register') {
    displayName = String(stopped(await p.text({
      message: t('init.displayName'),
      placeholder: t('init.displayName.hint'),
      validate: (value) => value.trim() ? undefined : t('init.displayName.empty')
    }))).trim();
  }

  const password = String(stopped(await p.password({
    message: t('init.password'),
    validate: (value) => value.length >= 12 ? undefined : t('init.password.short')
  })));
  if (mode === 'register') {
    const again = String(stopped(await p.password({
      message: t('init.password.again'),
      validate: (value) => value === password ? undefined : t('init.password.mismatch')
    })));
    if (again !== password) {
      p.cancel(t('init.password.mismatch'));
      process.exit(0);
    }
  }

  const skillScope = stopped(await p.select({
    message: t('init.skillScope'),
    options: [
      { value: 'global', label: t('init.skillScope.global'), hint: t('init.skillScope.global.hint') },
      { value: 'local', label: t('init.skillScope.local'), hint: t('init.skillScope.local.hint') }
    ]
  }));

  let projectPath = cwd;
  if (skillScope === 'local') {
    projectPath = resolve(String(stopped(await p.text({
      message: t('init.projectPath'),
      initialValue: cwd,
      hint: t('init.projectPath.hint')
    }))));
  }

  const hosts = stopped(await p.multiselect({
    message: t('init.hosts'),
    options: [
      { value: 'claude', label: 'Claude Code', hint: '.claude/skills' },
      { value: 'codex', label: 'Codex', hint: '.agents/skills' }
    ],
    initialValues: ['claude', 'codex'],
    required: true
  }));

  const characterIds = stopped(await p.groupMultiselect({
    message: t('init.characters'),
    options: {
      [t('init.characters.it')]: CHARACTERS.filter((item) => item.cluster === 'it').map((item) => ({
        value: item.id,
        label: `${item.name} — ${item.role}`
      })),
      [t('init.characters.industry')]: CHARACTERS.filter((item) => item.cluster === 'industry').map((item) => ({
        value: item.id,
        label: `${item.name} — ${item.role}`
      }))
    },
    required: false,
    selectableGroups: false
  })) || [];

  const plan = { serverUrl, mode, email, password, displayName, skillScope, projectPath, hosts, characterIds };
  p.note(summarizePlan(plan, t), t('init.summary'));
  const ok = stopped(await p.confirm({
    message: t('init.confirm'),
    initialValue: true
  }));
  if (!ok) {
    p.cancel(t('init.cancelled'));
    process.exit(0);
  }
  return plan;
}

export async function runInit() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(t('init.needsTty'));
  }
  const plan = await collectPlan();
  const spin = p.spinner();
  const labels = {
    account: t(plan.mode === 'register' ? 'init.progress.register' : 'init.progress.login'),
    vault: t('init.progress.vault'),
    catalog: t('init.progress.catalog'),
    playbook: t('init.progress.playbook'),
    skills: t('init.progress.skills')
  };
  spin.start(t('init.progress.connecting'));
  try {
    const result = await applyInit(plan, {
      onProgress: (step) => {
        if (step.startsWith('agent:')) spin.message(t('init.progress.agent', { name: step.slice(6) }));
        else spin.message(labels[step] || step);
      }
    });
    spin.stop(t('init.progress.done'));
    const agentLines = result.enrolled.length
      ? result.enrolled.map((item) => `  ${item.id} → ${item.home}`).join('\n')
      : `  ${t('init.written.noAgents')}`;
    p.note(
      [
        t('init.written.home', { path: result.home }),
        t('init.written.skill'),
        ...result.installedSkills.map((path) => `  ${path}`),
        t('init.written.agents'),
        agentLines,
        '',
        t('init.written.next')
      ].join('\n'),
      t('init.written')
    );
    p.outro(t('init.outro'));
  } catch (error) {
    spin.stop(t('init.progress.failed'));
    throw error;
  }
}
