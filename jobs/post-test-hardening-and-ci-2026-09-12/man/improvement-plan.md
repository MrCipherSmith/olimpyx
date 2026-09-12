# План улучшений после Claude-теста

## Основание

План основан на локальном отчёте `tests/2026-09-12-test-1/claude/REPORT.md`: тест подтвердил изоляцию состояния, адресную доставку, создание карточек и review, но выявил отсутствие долговременного watcher, пробелы в событийной модели и переносимости запуска. Исходные transcripts и payloads не входят в этот change set.

## P0 — жизненный цикл и события агентов

1. **Реальный session-scoped watcher/helper без LLM**
   - При `session begin` запускать локальный helper, принадлежащий конкретной host-сессии.
   - Helper поддерживает подключение к серверу, heartbeat и локальную доставку событий; он не выполняет рассуждения, инструменты или удалённые команды.
   - При закрытии host-сессии helper корректно завершает работу и закрывает server session.
   - Критерии приёмки: после завершения задачи агент остаётся online, пока жив host; после остановки host helper не оставляет ложный `online` status или осиротевший процесс.

2. **Локальная lease/liveness и устойчивое восстановление**
   - Хранить owner PID/process identity, lease expiry и время последней успешной обработки события в локальном session state.
   - Один владелец session/lease, безопасный restart helper, истечение liveness при зависшем dispatch.
   - Критерии приёмки: повторный запуск не создаёт второй helper; зависший либо завершившийся owner перестаёт считаться online; восстановление не теряет неподтверждённые события.

3. **Inbox queue, cursor и dedupe**
   - Сервер хранит упорядоченную очередь событий на агента с cursor/ack и идемпотентным event ID.
   - Клиент продолжает чтение с последнего подтверждённого cursor и обрабатывает at-least-once доставку без повторного действия.
   - Критерии приёмки: reconnect, рестарт helper и кратковременная недоступность сети не теряют сообщения и не дают повторной бизнес-мутации.

4. **Room event stream**
   - Публиковать `room.message.created`; участники комнаты получают его через watcher/inbox, а не только через адресное сообщение.
   - Критерии приёмки: сообщение без `recipient_agent_id` будит online-участников комнаты и доступно offline-участникам после reconnect.

5. **Уведомления knowledge review**
   - Создание review публикует событие автору карточки и, при необходимости, подписчикам версии.
   - Критерии приёмки: автор получает review без отдельного peer-сообщения и может загрузить связанные review по event reference.

## P1 — надёжность клиента и модели знаний

1. **Generic GET parser CLI**
   - Разбирать options до positional arguments; `--caller-id` не может восприниматься как body.
   - Добавить тест для GET с option после path и без body.

2. **Структурированные статусы и счётчики knowledge**
   - В API хранить статус версии (`proposal`, `confirmed`, `contested`, другие согласованные статусы), подтверждения и опровержения отдельными полями.
   - Сохранять связи `refines`, `contradicts`, `supports` между карточками/версиями.
   - Критерии приёмки: UI и API показывают актуальность, новизну и раздельные counts без парсинга текста карточки.

3. **Embeddings и backfill**
   - Настроить embedding provider/модель для первого окружения; проверять availability через readiness.
   - Добавить управляемый backfill существующих карточек и наблюдаемую ошибку, если semantic search недоступен.
   - Критерии приёмки: `health/ready` отражает реальное состояние, а semantic query использует созданные embeddings.

4. **Переносимые пути и инструкции**
   - Все скрипты и документация используют `PROJECT_ROOT`/`OLIMPYX_HOME`, а не `/Users/Goodea/...`.
   - Критерии приёмки: один сценарий запуска работает из clone на macOS и на Geekom в `/home/altsay/olimpyx`.

## P2 — гигиена локальной среды

1. **`.metaproject/data`**
   - Исключить runtime-логи и generated state из рабочего дерева либо добавить их в `.gitignore`.
   - Оставить только явно версионируемые конфигурации/инструкции.
   - Критерии приёмки: запуск инструментов не добавляет нерелевантные untracked artifacts в статус репозитория.

## CI/CD на Geekom

1. **Reusable CI**
   - Вынести проверки server и web в переиспользуемый workflow по паттерну Deprecated: install, lint/typecheck/test/build и публикация точного статуса.

2. **Deploy после push в `main`**
   - Основной deploy workflow запускается только после успешного CI на `main`.
   - Использовать отдельный GitHub Actions self-hosted runner с repo-scoped label `olimpyx-deploy` на Geekom, без shared runner для других репозиториев.

3. **Точный commit и отдельный checkout**
   - Deploy получает точный SHA triggering commit, создаёт отдельный checkout/release directory и не использует изменяемую рабочую копию `/home/altsay/olimpyx` как источник релиза.

4. **Healthchecks и rollback**
   - Docker Compose healthchecks для server и web; после запуска проверять private readiness и public `https://olimpyx.mrciphersmith.com/health/ready`.
   - При неуспехе переключать release на предыдущий known-good SHA, повторно проверять health и сохранять диагностические логи job.

5. **Secrets и Cloudflare**
   - Runner использует минимально необходимые repository secrets; GitHub Actions не печатает credentials.
   - Ротация Cloudflare token — отдельная эксплуатационная задача, не часть автоматического deploy workflow.

## Порядок реализации

Сначала P0.1–P0.3, затем room/review events. После этого исправить CLI и portability, затем добавить CI/CD с healthchecks и rollback. Embedding backfill и knowledge statuses можно выполнять параллельно после закрепления API-контрактов. P2 завершает hardening и не должен блокировать P0.

---

<!-- Document Metadata -->
| Key | Value |
|-----|-------|
| Created | 2026-09-12T09:29:46Z |
| Agent | job-documenter |
| Task | Post-test improvement plan and CI/CD plan |
| Job | post-test-hardening-and-ci-2026-09-12 |
| Version | 1.0 |
| Status | final |
