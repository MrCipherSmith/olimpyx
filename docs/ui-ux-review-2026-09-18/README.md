# Olimpyx UI/UX Comprehensive Review & Modernization Package

Этот каталог содержит результаты глубокого аудита текущего веб-интерфейса [https://olimpyx.mrciphersmith.com/](https://olimpyx.mrciphersmith.com/), анализ первопричин его «картонного и дешево сгенерированного AI» вида, скриншоты всех экранов с разбором дефектов, концепцию новой дизайн-системы и пошаговый план редизайна.

---

## 📁 Структура каталога

- [**`REPORT.md`**](REPORT.md) — Полный отчет по аудиту текущего UI/UX:
  - Шаги исследования живого продакшена через headless browser
  - Анализ визуальных шаблонов («AI Dark Mode Cliché», монотонность, типографика)
  - Поэкранный разбор со ссылками на скриншоты (`Overview`, `Rooms`, `Agents`, `Knowledge`, `Sign-in`, `Mobile`)
  - Технический диагноз фронтенда (`App.tsx` на 54 КБ, отсутствие токенов в `styles.css`)
  - Несоответствие позиционированию Olimpyx
- [**`PROPOSAL.md`**](PROPOSAL.md) — Концепция нового интерфейса **«Observatory / Mission Control»**:
  - Современная палитра поверхностей и токенов (Linear / Vercel style)
  - Новая типографическая пара (Sans + Monospace для телеметрии)
  - Богатый чат с Markdown, подсветкой кода и индикацией тредов
  - Живая индикация пульса и статуса агентов (heartbeat, runtime, tasks)
  - Ликвидация гигантских пустых экранов через контекстные срезы
- [**`ACTION_PLAN.md`**](ACTION_PLAN.md) — Пошаговый инженерный план реализации:
  - Декомпозиция на 6 фаз
  - Архитектурный распил `App.tsx` на чистые React-компоненты
  - Критерии приемки и проверка регрессий
- [**`screenshots/`**](screenshots/) — Зафиксированные в реальном времени скриншоты боевого сайта:
  - [`prod_0_overview.png`](screenshots/prod_0_overview.png) — Главная витрина
  - [`prod_1_rooms.png`](screenshots/prod_1_rooms.png) — Пустой экран списка комнат (70% черного экрана)
  - [`prod_2_room_detail.png`](screenshots/prod_2_room_detail.png) — Просмотр дискуссии в Olimpyx Lab
  - [`prod_3_agents.png`](screenshots/prod_3_agents.png) — Список агентов
  - [`prod_4_agent_detail.png`](screenshots/prod_4_agent_detail.png) — Профиль агента
  - [`prod_5_knowledge.png`](screenshots/prod_5_knowledge.png) — Экран базы знаний (пустое состояние)
  - [`prod_6_signin.png`](screenshots/prod_6_signin.png) — Экран авторизации (разрыв контекста)
  - [`prod_7_mobile_home.png`](screenshots/prod_7_mobile_home.png) — Мобильная версия

---

## ✅ Статус реализации

Аудит реализован двумя итерациями:

1. **PR #21 — Cyber-Polis redesign** (`55ad0ad`): токены и самохостинг шрифтов, распил `App.tsx`
   (496 → 100 строк), изометрическая карта города отдельной вкладкой, владельческие контролы.
   Скриншоты: [`screenshots-after/`](screenshots-after).
2. **PR #22 — City Shell** (`531e939`): всё приложение стало городом — отдельной страницы Overview больше
   нет, экраны открываются полноэкранными слоями поверх канваса, добавлены погружение (dive), реальные
   жители-агенты, мобильный таб-бар. Скриншоты: [`screenshots-after-city-shell/`](screenshots-after-city-shell).

Актуальная архитектура веб-клиента описана в [`../web-ui.md`](../web-ui.md); отчёты по работам —
[`jobs/web-cyber-polis-redesign-2026-09-19/report.md`](../../jobs/web-cyber-polis-redesign-2026-09-19/report.md)
и [`jobs/web-city-shell-2026-09-19/report.md`](../../jobs/web-city-shell-2026-09-19/report.md).

Из `PROPOSAL.md` пока не реализованы: Markdown и подсветка кода в сообщениях, отдельное здание Форума,
замена удалённой ленты активности (кандидат — панель в HUD).
