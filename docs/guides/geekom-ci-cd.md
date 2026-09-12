# CI/CD для Geekom

Olimpyx использует тот же подход, что и проект Deprecated: проверки выполняются на GitHub-hosted runner, а deployment — на отдельном self-hosted runner на Geekom. Серверу не нужен публичный SSH и не нужны GitHub secrets с SSH- или Tailscale-ключами.

## Поток deployment

1. Pull request запускает `.github/workflows/check.yml` и должен пройти typecheck, тесты, сборку, browser checks и сборку production Docker images.
2. Push в `main` запускает `.github/workflows/deploy.yml`.
3. Deploy workflow повторно вызывает тот же CI как reusable workflow.
4. После зелёного CI job с label `olimpyx-deploy` выполняется на Geekom.
5. Runner разворачивает точный `github.sha`, пересобирает API и web, ждёт Docker healthchecks и проверяет публичный endpoint Cloudflare Tunnel.
6. При ошибке deployment возвращает последний успешно проверенный commit и пересобирает контейнеры. Ошибка самого rollback помечается отдельным exit code и требует ручного восстановления.

Параллельные production deployments выполняются последовательно. Новый запуск не отменяет уже начавшийся deployment.

## Каталоги сервера

Инструкции используют переменные и не зависят от локального пути разработчика:

```bash
export OLIMPYX_SOURCE_DIR="${OLIMPYX_SOURCE_DIR:-$HOME/olimpyx}"
export OLIMPYX_DEPLOY_DIR="${OLIMPYX_DEPLOY_DIR:-$HOME/olimpyx-deploy}"
```

- `OLIMPYX_SOURCE_DIR` — исходная пользовательская копия и источник локальных runtime-файлов.
- `OLIMPYX_DEPLOY_DIR` — отдельная копия, которой управляет CI/CD.

Deployment не выполняет `git clean` и не изменяет пользовательскую копию. Перед каждым запуском он синхронизирует из неё gitignored `compose.override.yaml` и `.env`; удаление исходного файла удаляет и устаревшую deploy-копию. Последний успешный SHA хранится в `$HOME/.local/state/olimpyx-deploy/last-successful-sha`. Docker Compose всегда использует project name `olimpyx`, поэтому первый deployment подхватывает существующие контейнеры и volume независимо от имени каталога.

Перед самым первым автоматическим deployment нужно один раз зафиксировать SHA текущей проверенной и работающей версии. Без него скрипт завершится до изменения контейнеров:

```bash
export OLIMPYX_SOURCE_DIR="${OLIMPYX_SOURCE_DIR:-$HOME/olimpyx}"
export OLIMPYX_STATE_DIR="${OLIMPYX_STATE_DIR:-$HOME/.local/state/olimpyx-deploy}"
curl --fail --silent --show-error http://127.0.0.1:4173/health/ready >/dev/null
install -d -m 700 "$OLIMPYX_STATE_DIR"
git -C "$OLIMPYX_SOURCE_DIR" rev-parse HEAD > "$OLIMPYX_STATE_DIR/last-successful-sha"
chmod 600 "$OLIMPYX_STATE_DIR/last-successful-sha"
```

Значения можно изменить через environment runner-сервиса:

```bash
export OLIMPYX_SOURCE_DIR="$HOME/olimpyx"
export OLIMPYX_DEPLOY_DIR="$HOME/olimpyx-deploy"
```

## Self-hosted runner

Для репозитория нужен отдельный repo-scoped runner с label `olimpyx-deploy`. На текущем Geekom он установлен в `$HOME/actions-runner-olimpyx` и запущен как пользовательский systemd-сервис `github-runner-olimpyx.service`. Linger для пользователя должен быть включён, чтобы сервис продолжал работать без SSH-сессии.

Проверка состояния:

```bash
systemctl --user status github-runner-olimpyx.service
```

Runner проекта Deprecated остаётся отдельным: repo-scoped runner нельзя использовать для другого репозитория без новой регистрации.

## GitHub environment

Deploy job использует environment `production-geekom`. Для автоматического режима ему не нужны repository secrets. При необходимости в GitHub можно включить protection rules для ветки `main` или ручное подтверждение environment.

## Cloudflare Tunnel

Tunnel продолжает проксировать `https://olimpyx.mrciphersmith.com` на локальный web-порт `127.0.0.1:4173`. Deployment проверяет `https://olimpyx.mrciphersmith.com/health/ready` после локальной проверки.

Текущий tunnel token передаётся через параметры systemd-сервиса. Его следует перевыпустить и перенести в root-only credential/environment file. Значение токена не должно попадать в репозиторий, runner или GitHub Actions.

## Ограничения отката

Откат контейнеров не откатывает данные PostgreSQL. Пока не появился отдельный backup/restore этап, миграции базы должны быть обратно совместимыми. Изменения схемы требуют отдельного deployment-процесса с резервной копией и проверенным rollback-планом.
