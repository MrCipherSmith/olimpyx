# PRD: Localization Integration for Olimpyx

> **Version:** 1.0 · **Date:** 2026-09-20 · **Author:** Mavis (mvs_358b8178e13b4c38954b54c3979893b1)
> **Worktree:** `feat/i18n-localization` at `/Users/Goodea/goodea/olimpyx-i18n`
> **Companion docs:** [`../ru/i18n-localization.md`](../ru/i18n-localization.md) · [`../ai/i18n-localization.md`](../ai/i18n-localization.md)

---

## 1. Overview

Wire up full bilingual localization (RU + EN) for the olimpyx web client (Cyber-Polis / City Shell), eliminate hard-coded label chaos, and embed a language switcher in the HUD next to the network indicator. The server stays language-neutral: client-localizes user-facing error messages via a code → message lookup table.

## 2. Context

- **Product:** Olimpyx — a "living city" network for humans and agents. Owners see their city as an isometric map populated by agent inhabitants; guests see a public showcase (`PublicShowcase`). UI is implemented as the Cyber-Polis City Shell (HUD + Canvas + Screen Layer).
- **Module:** `apps/web` — React 18 + TypeScript + Vite. The backend `apps/server` (Fastify + PostgreSQL) is out of scope.
- **User Role:** `owner` and `guest`. Both share exactly one visual language.
- **Tech Stack:** React 18.3, TypeScript 5.8, Vite 7, lucide-react, Vitest, Playwright. New dependencies: `i18next`, `react-i18next`, `i18next-browser-languagedetector`. No third-party UI frameworks.

## 3. Problem Statement

Three classes of labels currently coexist in the codebase:

1. **Fully English** hard-codes in HUD, nav, screen eyebrow/title, AuthScreen, PublicShowcase, NetworkStatusBadge, UsageCard — almost all of the upper-level chrome.
2. **Russian only** — `cityScene.ts` (`label: 'Преторий'`, `'Центральная Библиотека'`, `'Пантеон Агентов'`) and most room/messaging copy.
3. **Already partially bilingual "stubs"** — `roomArchetypes.ts` keeps `label`/`labelEn`, `name`/`nameEn`, but UI reads only `label`.

Result: the same building is called "Pantheon of Agents" in the HUD and "Пантеон Агентов" in the building label; one message may be Russian, the next one English; the user has no way to switch. This breaks product trust and blocks audience expansion.

## 4. Goals

- **G1.** Every user-visible UI string comes from the i18n catalog; hard-codes in JSX/TS are removed.
- **G2.** Full RU + EN coverage at launch; adding a third language requires no refactor.
- **G3.** Language switcher is reachable in one click from the HUD, never breaks UX (no reload, no state loss).
- **G4.** Existing bilingual scene data (`label`/`labelEn`, `name`/`nameEn`) becomes part of a single system: components read strings through a locale-aware selector instead of duplicating logic.
- **G5.** Every server error is shown to the user in their language through an `error.code → message` table; unknown codes fall back to raw `message`.
- **G6.** Auto-test coverage: every key surface (HUD, nav, Auth, PublicShowcase, room screen, knowledge, agents, owner) has a RU↔EN switch scenario.

## 5. Non-Goals

- **NG1.** Localizing server business logic, logs, or SQL messages.
- **NG2.** Translating agent-generated content (`bio`, `topic`, `summary`, knowledge card `body`) — that content is authored, not translated automatically.
- **NG3.** RTL support (Arabic, Hebrew). Architecture is ready (separate locale file, no hard-coded margins); visual RTL is a separate epic.
- **NG4.** Translating admin/CLI/scripts UI if/when it appears.
- **NG5.** Region-precise dates/numbers/currencies at launch (only basic i18next plural).
- **NG6.** Sending language preferences to the backend — client stores the choice in `localStorage`.

## 6. Functional Requirements

| ID | Requirement |
|----|-------------|
| **FR-1** | Wire up `i18next` + `react-i18next` + `i18next-browser-languagedetector` in `apps/web`. Single config module `apps/web/src/i18n/index.ts`. |
| **FR-2** | Locale catalogs: `apps/web/src/i18n/locales/ru/common.json` and `…/en/common.json`. `common` namespace for shared strings; sub-namespaces `hud`, `auth`, `showcase`, `rooms`, `knowledge`, `agents`, `owner`, `city`, `errors`. |
| **FR-3** | Language detection priority: `localStorage['olimpyx.locale']` → `navigator.language` → `ru` (fallback). Supported codes: `ru`, `en`. |
| **FR-4** | Persistence: on first manual switch, save the choice under `localStorage['olimpyx.locale']`. Storage schema version: `1`. |
| **FR-5** | `LanguageSwitcher` renders in the HUD next to `NetworkStatusBadge`: lucide `globe` icon + current code (`RU`/`EN`). Click toggles the locale. On mobile (`@media (max-width: 768px)`) the switcher moves into the account zone of the HUD (same group as sign-out) — MobileTabBar is left untouched. |
| **FR-6** | Full localization for strings in: HUD (brand, eyebrow, nav items, stats labels, account copy), screen layer (eyebrow/title/actions), AuthScreen (every label, button, form error), PublicShowcase (labels + filters), RoomsPanel (titles, placeholders, empty states), KnowledgePanel, AgentsPanel, OwnerPanel, UsageCard, friendlyError, Loading/Empty/ErrorText. |
| **FR-7** | Scene data selector: new utility `localizeArchetype(record, locale)` (`apps/web/src/lib/label.ts`) returns `labelEn`/`summaryEn` for `en`, otherwise `label`/`summary`. Applied in `cityScene.ts`, `roomArchetypes.ts`, `CityBuildingList`, and any `CityCanvas` overlays. |
| **FR-8** | Server errors: extend `apps/web/src/lib/api.ts` with `humanizeError(error)` that takes `ApiError` (status + code + raw message) and returns the localized text via `t('errors:CODE', { defaultValue: raw.message })`. Unknown codes → return `raw.message` with `(en)` suffix in DEV only. |
| **FR-9** | Presence statuses (`online`/`offline`/`away`) — map in `presence.ts`. Knowledge card statuses (`draft`/`review`/`published`/`retracted`) — map in `statusBadge.ts`. |
| **FR-10** | `useT(ns?)` wrapper around `useTranslation`. Lint rule (custom ESLint rule or PR checklist) + unit test on regex for "leftover Cyrillic / Latin literals in JSX". |
| **FR-11** | Snapshot tests (Vitest + Testing Library) for HUD, AuthScreen, PublicShowcase in both locales. |
| **FR-12** | E2E (Playwright) scenario: open `/`, switch RU→EN, verify key labels (`Sign in to Olimpyx` ↔ `Войти в Olimpyx`), close/reopen — choice is persisted. |

## 7. Non-Functional Requirements

- **NFR-1 — Performance.** Switching locale must not unmount stateful components (open rooms, active screen, in-flight form). Use `i18next` with `suspense: false`.
- **NFR-2 — Bundle size.** Combined `ru` + `en` catalogs ≤ 30 KB gzipped. No `moment`, no per-locale `date-fns`.
- **NFR-3 — Accessibility.** `LanguageSwitcher` exposes `aria-label`, is keyboard reachable, activates on Space/Enter, has a visible focus-ring (already provided by HUD styles). Hidden `<html lang="…">` is updated synchronously.
- **NFR-4 — Type safety.** Catalog keys are typed (via `i18next-typescript` or a manual `Resources` type); missing key → compile-time error in dev, silent fallback in prod.
- **NFR-5 — Compatibility.** All existing Vitest/Playwright tests continue to pass. No React/Vite bump.
- **NFR-6 — Observability.** In DEV, missing keys trigger `console.warn(key + locale)`; in PROD — silent.

## 8. Constraints

- **C1 — Architectural.** Keep `apps/web/src/components/{shell,shared,city,rooms,…}` structure; no renames. New code lives in `apps/web/src/i18n/` and `apps/web/src/lib/label.ts`.
- **C2 — Tech stack.** Only `i18next` / `react-i18next` / `i18next-browser-languagedetector`. No `react-intl`, `lingui`, `@formatjs`.
- **C3 — Design.** Cyber-Polis visual style stays untouched. Switcher is a compact HUD button (`globe` icon + 2 letters), reusing existing tokens from `tokens.css`.
- **C4 — Backward-compat.** Existing `label`/`labelEn`, `name`/`nameEn` fields remain in the data; components move to the `localizeArchetype(…, locale)` selector.
- **C5 — Server.** No API / DB changes. Client only.
- **C6 — Catalog.** Single source of truth — JSON in `apps/web/src/i18n/locales/`. Same string in RU and EN is allowed only for non-localizable tokens (brand `OLIMPYX`).

## 9. Edge Cases

| Case | Behavior |
|------|----------|
| First run, empty `localStorage`, `navigator.language = 'de-DE'` | Fallback to `ru`. |
| `localStorage` has `fr` | Fallback to `ru`; `fr` is silently overwritten on next manual switch. |
| Switch language while room polling is active | Polling continues; active screen stays open. |
| `en` has a key, `ru` does not | Show `en`; dev-warn in console. |
| `ru` has a key, `en` does not | Show `ru`; dev-warn in console. |
| Server returns error without a code | Show `raw.message` without suffix in PROD; `[no-code]` suffix in DEV. |
| Two tabs open, switch language in one | Only that tab updates (no `BroadcastChannel`); persistence is per-tab. |
| Switch on phone | Switcher lives in HUD account zone, not in MobileTabBar. |
| Long translation breaks HUD | Existing `.hud-link-label { text-overflow: ellipsis }`; if translation > 24 chars, use an abbreviation in the catalog. |
| i18next-typescript fails in CI | CI allows warnings (not errors); pre-push hook — warning. |

## 10. Acceptance Criteria (Gherkin)

> Full scenarios and catalog key table live in [`../ai/i18n-localization.md`](../ai/i18n-localization.md). Summary below.

### AC-1. Locale detection and persistence
```gherkin
Given the user opens the app for the first time
And localStorage has no key 'olimpyx.locale'
And navigator.language = 'en-US'
When the app is fully loaded
Then active locale is 'en'
And <html lang="en">
```

### AC-2. Manual switch
```gherkin
Given the user is on locale 'ru'
And the page '/' is open
When the user clicks the language switcher in the HUD
Then active locale is 'en'
And localStorage['olimpyx.locale'] = 'en'
And all visible labels switch to English
And full-screen panels (AuthScreen, PublicShowcase, room screen) also show English
```

### AC-3. Persistence across sessions
```gherkin
Given the user selected 'en'
And closed the tab
When they open the app again
Then active locale is 'en' without a flash of Russian copy
```

### AC-4. Server error localization
```gherkin
Given active locale is 'ru'
When the server returns ApiError(status=400, code='validation_error', message='Invalid request fields')
Then the user sees the localized message «Проверьте правильность полей»
And raw.message is NOT shown
```

### AC-5. Bilingual scene data
```gherkin
Given active locale is 'en'
And City View is open
Then building labels show 'labelEn' (e.g. "Central Library", "Pantheon of Agents")
When the user switches locale to 'ru'
Then building labels instantly switch to Russian ("Центральная Библиотека", "Пантеон Агентов")
```

### AC-6. Unknown locale
```gherkin
Given localStorage['olimpyx.locale'] = 'fr'
When the app loads
Then active locale is 'ru' (fallback)
And no errors in console
```

### AC-7. Accessibility
```gherkin
Given the user is on keyboard
When Tab focus reaches LanguageSwitcher
Then the element has a visible focus ring
And Space/Enter switches locale
And aria-label="Switch language" (ru) / "Switch language" (en) — both variants translated
```

### AC-8. Regression — content filtering
```gherkin
Given the knowledge list is open in locale 'ru'
When the user applies filter 'квант'
Then the filter applies to Russian and English text (server is identical)
And the UI shows results in the current locale
```

## 11. Verification

### 11.1 Build & types
- `npm run typecheck` — clean, including generated catalog types.
- `npm run build` — succeeds; bundle does not grow by > 30 KB gzipped (RU + EN).

### 11.2 Unit tests (Vitest)
- `npm run test --workspace @olimpyx/web` — all existing tests pass.
- New tests:
  - `i18n/index.test.ts` — detection, persistence, fallback.
  - `lib/label.test.ts` — `localizeArchetype`.
  - `lib/api.test.ts` — `humanizeError` code mapping.
  - Snapshot tests for HUD / AuthScreen / PublicShowcase on RU and EN.

### 11.3 E2E (Playwright)
- `npm run test:e2e` — `i18n.spec.ts` scenario: detect → switch → persist → server-error localization.
- Existing e2e (`city-shell-nav`, `showcase`, `participant-layout`) pass unchanged.

### 11.4 Lint & quality
- ESLint + new custom rule `no-hardcoded-ui-strings` (prohibits literals > 3 words inside JSX `<p>`, `<h*>`, `<button>`, `aria-label` outside the catalog).
- Lint must NOT flag technical constants (`'ru'`, `'en'`, `'online'`, `'offline'`).

### 11.5 Observability & UX
- Lighthouse a11y ≥ 95 on desktop.
- Manual visual regression of HUD (report in `docs/requirements/i18n-localization-2026-09-20/follow-up.md` after rollout).

### 11.6 Rollback
- Changes are isolated to branch `feat/i18n-localization`. On regression — revert PR; the product keeps working off the hard-codes.

---

## 12. Open Questions (implementation phase)

1. **`i18next-typescript` vs manual `Resources` type?** — Recommend manual type (less tooling).
2. **Pre-push hook or CI script** for catalog coverage? — Recommend CI script `scripts/i18n-coverage.mjs` (easier to maintain).
3. **Who maintains `en`?** — Project owner; machine translation is banned for production.

---

> This document is synchronized with [`../ru/i18n-localization.md`](../ru/i18n-localization.md) (Russian human version) and [`../ai/i18n-localization.md`](../ai/i18n-localization.md) (machine-readable version with key tables and extended Gherkin).