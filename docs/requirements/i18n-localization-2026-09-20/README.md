# PRD Pack: Localization Integration (2026-09-20)

Three synchronized variants of the same Product Requirements Document:

| Variant | Audience | Path |
|---------|----------|------|
| 🇷🇺 Russian (human) | Разработчики, владелец продукта, говорящие на русском | [`ru/i18n-localization.md`](./ru/i18n-localization.md) |
| 🇬🇧 English (human) | International contributors, AI agents prompted in English | [`en/i18n-localization.md`](./en/i18n-localization.md) |
| 🤖 AI-readable | Implementation agents, code reviewers, automation | [`ai/i18n-localization.md`](./ai/i18n-localization.md) |

## TL;DR

Подключить полноценную двуязычную локализацию (RU + EN) в клиент olimpyx, устранить хаос хардкод-лейблов (часть русская, часть английская, часть двуязычная в одних и тех же местах), встроить переключатель языка в HUD рядом с `NetworkStatusBadge`. Сервер остаётся языково-нейтральным — клиент локализует пользовательские сообщения об ошибках по таблице `error.code → message`.

## Решения, зафиксированные в этом пакете

| Развилка | Решение |
|----------|---------|
| Целевые языки | RU + EN на старте; архитектура готова к третьему языку |
| Технология | `i18next` + `react-i18next` + `i18next-browser-languagedetector` |
| Расположение переключателя | HUD, рядом с `NetworkStatusBadge` (на мобильном — в account-зоне HUD) |
| Серверные строки | Клиент локализует по `error.code`; неизвестные коды → raw `message` с пометкой `(en)` только в DEV |

## Статус

- ✅ PRD-пакет сформирован
- ⏳ Имплементация не начата (ожидает старта отдельной задачи `task-implementer`)
- ⏳ Тесты не написаны
- ⏳ ESLint-правило не добавлено

## Связанные материалы

- Ветка: `feat/i18n-localization` (worktree `/Users/Goodea/goodea/olimpyx-i18n`)
- Базовый коммит: `531e939 feat(web): the whole app as the city (city shell, dive navigation, real inhabitants) (#22)`
- Roadmap проекта: [`../../ROADMAP.md`](../../ROADMAP.md)