# PRD: Интеграция локализации в Olimpyx

> **Версия:** 1.0 · **Дата:** 2026-09-20 · **Автор:** Mavis (mvs_358b8178e13b4c38954b54c3979893b1)
> **Worktree:** `feat/i18n-localization` в `/Users/Goodea/goodea/olimpyx-i18n`
> **Связанные пакеты:** [`../en/i18n-localization.md`](../en/i18n-localization.md) · [`../ai/i18n-localization.md`](../ai/i18n-localization.md)

---

## 1. Overview

Подключить полноценную двуязычную локализацию (RU + EN) в клиент olimpyx (Cyber-Polis / City Shell), устранить хаос хардкод-лейблов и встроить переключатель языка в HUD рядом с индикатором сети. Сервер остаётся языково-нейтральным: пользовательские сообщения об ошибках клиент локализует сам по таблице кодов.

## 2. Context

- **Продукт:** Olimpyx — сеть «живого города» для людей и агентов: владелец видит свой город как изометрическую карту с жителями-агентами; гость видит публичную витрину (`PublicShowcase`). UI построен как Cyber-Polis City Shell (HUD + Canvas + Screen Layer).
- **Модуль:** `apps/web` — React 18 + TypeScript + Vite. Бэкенд `apps/server` (Fastify + PostgreSQL) в задачу не входит.
- **User Role:** владелец (`owner`) и гость (`guest`). У обоих ровно один и тот же визуальный язык.
- **Tech Stack:** React 18.3, TypeScript 5.8, Vite 7, lucide-react, Vitest, Playwright. Новые зависимости: `i18next`, `react-i18next`, `i18next-browser-languagedetector`. Никаких сторонних UI-фреймворков.

## 3. Problem Statement

В коде одновременно сосуществуют три класса лейблов:

1. **Полностью английские** хардкоды в HUD, nav, screen eyebrow/title, AuthScreen, PublicShowcase, NetworkStatusBadge, UsageCard — почти весь верхнеуровневый chrome.
2. **Только русские** — `cityScene.ts` (`label: 'Преторий'`, `'Центральная Библиотека'`, `'Пантеон Агентов'`) и большинство подписей в комнатах/месенджере.
3. **Уже частично двуязычные «заготовки»** — `roomArchetypes.ts` хранит `label`/`labelEn`, `name`/`nameEn`, но UI читает только `label`.

Результат: один и тот же город называет пантеон то «Pantheon of Agents» (HUD), то «Пантеон Агентов» (подпись здания); в одном сообщении может всплыть русский текст, в соседнем — английский; у пользователя нет способа переключиться. Это ломает доверие к продукту и делает невозможным расширение аудитории.

## 4. Goals

- **G1.** Каждая видимая пользователю строка UI приходит из i18n-каталога; хардкоды в JSX/TS устранены.
- **G2.** Полное покрытие двумя языками (RU + EN) на старте; добавление третьего языка не требует рефакторинга.
- **G3.** Переключатель языка доступен в один клик из HUD, не ломает UX (без перезагрузки, без потери состояния).
- **G4.** Существующие двуязычные данные сцены (`label`/`labelEn`, `name`/`nameEn`) становятся частью единой системы: компоненты читают строку через селектор по текущей локали, а не дублируют логику.
- **G5.** Все серверные ошибки показываются пользователю на его языке через таблицу `error.code → message`; неизвестные коды показывают сырой `message` как fallback с пометкой «en».
- **G6.** Покрытие автотестами: каждая ключевая поверхность (HUD, nav, Auth, PublicShowcase, room screen, knowledge, agents, owner) имеет сценарий переключения RU↔EN.

## 5. Non-Goals

- **NG1.** Локализация серверной бизнес-логики, логов и SQL-сообщений.
- **NG2.** Полнотекстовый перевод контента, который генерируют сами агенты (`bio`, `topic`, `summary`, `body` карточек знаний) — этот контент авторский и не переводится автоматически.
- **NG3.** RTL-поддержка (арабский, иврит). Архитектура готова (отдельный файл каталога, no hard-coded margins), но визуальная RTL-доработка — отдельный эпик.
- **NG4.** Перевод интерфейса админки/CLI/скриптов, если они появятся.
- **NG5.** Локализация дат/чисел/валют с региональной точностью до старта (только базовая plural-форма через i18next).
- **NG6.** Сетевой трафик языковых предпочтений на бэкенд — клиент сам хранит выбор в `localStorage`.

## 6. Functional Requirements

| ID | Требование |
|----|------------|
| **FR-1** | Подключить `i18next` + `react-i18next` + `i18next-browser-languagedetector` в `apps/web`. Конфиг — единый модуль `apps/web/src/i18n/index.ts`. |
| **FR-2** | Каталоги переводов: `apps/web/src/i18n/locales/ru/common.json` и `…/en/common.json`. Namespace `common` для общих строк; под-пространства `hud`, `auth`, `showcase`, `rooms`, `knowledge`, `agents`, `owner`, `city`, `errors` для группировки. |
| **FR-3** | Детект языка в порядке приоритета: `localStorage['olimpyx.locale']` → `navigator.language` → `ru` (fallback). Поддерживаемые коды: `ru`, `en`. |
| **FR-4** | Persistence: при первом ручном переключении сохранять выбор в `localStorage` под ключом `olimpyx.locale`. Версия схемы хранения — `1`. |
| **FR-5** | Переключатель `LanguageSwitcher` рендерится в HUD рядом с `NetworkStatusBadge`: иконка `globe` (lucide) + текущий код (`RU`/`EN`). Клик переключает локаль. На мобильном (`@media (max-width: 768px)`) переключатель переносится в account-зону HUD (та же группа, что и кнопка выхода) — MobileTabBar не трогаем. |
| **FR-6** | Полная локализация строк в: HUD (brand, eyebrow, nav items, stats labels, account copy), screen layer (eyebrow/title/actions), AuthScreen (все надписи, кнопки, ошибки формы), PublicShowcase (все подписи + фильтры), RoomsPanel (titles, placeholders, empty states), KnowledgePanel, AgentsPanel, OwnerPanel, UsageCard, friendlyError, Loading/Empty/ErrorText. |
| **FR-7** | Селектор локализованных полей данных сцены: новая утилита `localizeArchetype(record, locale)` (`apps/web/src/lib/label.ts`) возвращает `labelEn`/`summaryEn` для `en`, иначе `label`/`summary`. Применяется в `cityScene.ts`, `roomArchetypes.ts`, `CityBuildingList`, `CityCanvas` подписях. |
| **FR-8** | Серверные ошибки: расширить `apps/web/src/lib/api.ts` — метод `humanizeError(error)` принимает `ApiError` (status + code + raw message), возвращает локализованное сообщение по таблице `error.code → t('errors:CODE', { defaultValue: raw.message })`. Если код неизвестен — вернуть `raw.message` с суффиксом `(en)` только в DEV-режиме. |
| **FR-9** | Локализация статусов присутствия агентов (`online`/`offline`/`away`) — маппинг в `presence.ts`. Локализация статусов карточек знаний (`draft`/`review`/`published`/`retracted`) — маппинг в `statusBadge.ts`. |
| **FR-10** | Хук `useT(ns?)` обёртка над `useTranslation` для удобства; запрет хардкодов вне каталога — линтер-правило (ESLint custom rule или PR-чеклист), плюс unit-тест на регекс «забытых кириллических/латинских литералов в JSX». |
| **FR-11** | Snapshot-тесты (Vitest + Testing Library) для HUD, AuthScreen и PublicShowcase на двух локалях. |
| **FR-12** | E2E (Playwright) сценарий: открыть `/`, переключить RU→EN, проверить ключевые лейблы (`Sign in to Olimpyx` ↔ `Войти в Olimpyx`), закрыть/открыть приложение — выбор сохранился. |

## 7. Non-Functional Requirements

- **NFR-1 — Производительность.** Переключение языка не должно вызывать re-mount компонентов с сохранённым состоянием (открытые комнаты, активный экран, форма). Использовать `i18next` в режиме `suspense: false`.
- **NFR-2 — Размер бандла.** Каталоги `ru` + `en` суммарно ≤ 30 KB gzipped. Не должно появиться `moment`, `date-fns-locale-*` и подобных тяжёлых зависимостей.
- **NFR-3 — Доступность.** `LanguageSwitcher` имеет `aria-label`, доступен по Tab, активируется Space/Enter, имеет визуальный focus-ring (уже есть в стилях HUD). Скрытый `<html lang="…">` обновляется синхронно с переключением.
- **NFR-4 — Тип-безопасность.** Ключи каталога типизированы (генерируются `i18next-typescript` или ручной `Resources` тип); отсутствующий ключ → ошибка компиляции в dev, тихий fallback в prod.
- **NFR-5 — Совместимость.** Не ломать существующие тесты Vitest/Playwright, не поднимать версию React/Vite.
- **NFR-6 — Наблюдаемость.** В DEV-режиме при отсутствии ключа в `console.warn` пишется ключ + текущая локаль; в PROD — тишина.

## 8. Constraints

- **C1 — Архитектурные.** Сохранить структуру `apps/web/src/components/{shell,shared,city,rooms,…}` без переименований. Новый код — в `apps/web/src/i18n/` и `apps/web/src/lib/label.ts`.
- **C2 — Технологические.** Только `i18next`/`react-i18next`/`i18next-browser-languagedetector`. Никаких `react-intl`, `lingui`, `@formatjs`.
- **C3 — Дизайн.** Визуальный стиль Cyber-Polis не меняется. Переключатель — компактная кнопка в HUD, иконка `globe` + 2 буквы, цветовая палитра — существующие токены (`tokens.css`).
- **C4 — Backward-compat.** Существующие поля `label`/`labelEn`, `name`/`nameEn` остаются в данных; компоненты переходят на селектор `localizeArchetype(…, locale)`.
- **C5 — Сервер.** Никаких изменений API/БД. Только клиент.
- **C6 — Каталог.** Один источник истины — JSON в `apps/web/src/i18n/locales/`. Дублирование строк между RU/EN запрещено без префикса (например, бренд `OLIMPYX` остаётся одинаковым).

## 9. Edge Cases

| Кейс | Поведение |
|------|-----------|
| Первый запуск, пустой `localStorage`, `navigator.language = 'de-DE'` | Fallback на `ru`. |
| `localStorage` содержит `fr` | Fallback на `ru`, ключ `fr` молча перезаписывается при следующем ручном выборе. |
| Переключение языка во время polling комнаты | Polling не прерывается, активный экран не закрывается. |
| В каталоге `en` есть ключ, в `ru` нет | Показать `en` строку, dev-warn в консоли. |
| В `ru` есть, в `en` нет | Показать `ru` строку, dev-warn в консоли. |
| Сервер вернул ошибку без кода | Показать `raw.message` без пометки в PROD; в DEV добавить `[no-code]`. |
| Пользователь открыл 2 вкладки, в одной переключил язык | Только локальная вкладка меняет язык (без `BroadcastChannel`); persistence — per-tab. |
| Переключение на телефоне | Переключатель в account-зоне HUD (не в MobileTabBar); на телефоне account-зона всё равно видна при раскрытии. |
| Длинный перевод ломает HUD | Применяется `text-overflow: ellipsis` уже существующий в `.hud-link-label`; если перевод > 24 символа — заменить на абревиатуру в каталоге. |
| i18n-typescript сломался в CI | В CI допускается warning, не error; в pre-push хук — warning. |

## 10. Acceptance Criteria (Gherkin)

> Полные сценарии и таблица ключей каталога — в [`../ai/i18n-localization.md`](../ai/i18n-localization.md). Здесь — сводка.

### AC-1. Детект и сохранение языка
```gherkin
Given пользователь впервые открывает приложение
And в localStorage нет ключа 'olimpyx.locale'
And navigator.language = 'en-US'
When приложение полностью загрузилось
Then активная локаль — 'en'
And <html lang="en">
```

### AC-2. Ручное переключение
```gherkin
Given пользователь на локали 'ru'
And открыта страница '/'
When пользователь кликает переключатель языка в HUD
Then активная локаль — 'en'
And localStorage['olimpyx.locale'] = 'en'
And все видимые лейблы изменились на английские
And полноэкранные панели (AuthScreen, PublicShowcase, room screen) тоже показывают английский
```

### AC-3. Persistence между сессиями
```gherkin
Given пользователь выбрал 'en'
And закрыл вкладку
When он снова открывает приложение
Then активная локаль — 'en' без вспышки русского текста
```

### AC-4. Серверные ошибки
```gherkin
Given активная локаль 'ru'
When сервер возвращает ApiError(status=400, code='validation_error', message='Invalid request fields')
Then пользователь видит локализованное сообщение «Проверьте правильность полей»
And raw.message не показывается
```

### AC-5. Двуязычные данные сцены
```gherkin
Given активная локаль 'en'
And открыта City View
Then подписи зданий (buildings) отображают 'labelEn' (например, «Central Library», «Pantheon of Agents»)
When пользователь переключает локаль на 'ru'
Then подписи зданий мгновенно меняются на русские («Центральная Библиотека», «Пантеон Агентов»)
```

### AC-6. Неизвестная локаль
```gherkin
Given localStorage['olimpyx.locale'] = 'fr'
When приложение загружается
Then активная локаль — 'ru' (fallback)
And в консоли нет ошибок
```

### AC-7. Доступность переключателя
```gherkin
Given пользователь использует клавиатуру
When Tab-фокус доходит до LanguageSwitcher
Then элемент имеет видимый focus-ring
And нажатие Space или Enter переключает локаль
And aria-label="Switch language" (ru) / "Switch language" (en) — оба варианта переведены
```

### AC-8. Регрессия — данные
```gherkin
Given открыт список знаний в локали 'ru'
When пользователь применяет фильтр 'квант'
Then фильтр применяется по русскому и английскому тексту (бэкенд одинаков)
And UI показывает результаты по текущей локали
```

## 11. Verification

### 11.1 Сборка и типы
- `npm run typecheck` — без ошибок, включая сгенерированные типы каталога.
- `npm run build` — успешная сборка; bundle не вырос > 30 KB gzipped (RU+EN).

### 11.2 Юнит-тесты (Vitest)
- `npm run test --workspace @olimpyx/web` — все существующие тесты проходят.
- Новые тесты:
  - `i18n/index.test.ts` — детект, persistence, fallback.
  - `lib/label.test.ts` — `localizeArchetype`.
  - `lib/api.test.ts` — `humanizeError` маппинг кодов.
  - Snapshot-тесты HUD/AuthScreen/PublicShowcase на RU и EN.

### 11.3 E2E (Playwright)
- `npm run test:e2e` — сценарий `i18n.spec.ts`: детект → переключение → persistence → server error локализация.
- Существующие e2e (`city-shell-nav`, `showcase`, `participant-layout`) проходят без изменений.

### 11.4 Линт и качество
- ESLint + новый кастомный rule `no-hardcoded-ui-strings` (вне каталога запрещены литералы > 3 слов в JSX `>`, `<p>`, `<h*>`, `<button>`, `aria-label`).
- Линт не должен падать на технические константы (`'ru'`, `'en'`, `'online'`, `'offline'`).

### 11.5 Наблюдаемость и UX
- Lighthouse a11y score ≥ 95 для десктопной версии.
- Ручная проверка визуального регреcca HUD (отчёт в `docs/requirements/i18n-localization-2026-09-20/follow-up.md` после внедрения).

### 11.6 Откат
- Изменения изолированы в ветке `feat/i18n-localization`. Если регрессия — revert PR, ключевой функционал продолжает работать на хардкодах.

---

## 12. Открытые вопросы (на этап реализации)

1. **i18next-typescript** или ручной `Resources` тип? → предлагаю ручной тип (меньше tooling).
2. **Pre-push хук** или **CI-скрипт** для проверки покрытия каталога? → CI-скрипт `scripts/i18n-coverage.mjs` (проще поддерживать).
3. **Кто поддерживает `en`?** → владелец проекта; машинный перевод запрещён для продакшена.

---

> Документ синхронизирован с [`../en/i18n-localization.md`](../en/i18n-localization.md) (английская человеческая версия) и [`../ai/i18n-localization.md`](../ai/i18n-localization.md) (машино-читаемая версия с таблицей ключей и расширенными Gherkin).