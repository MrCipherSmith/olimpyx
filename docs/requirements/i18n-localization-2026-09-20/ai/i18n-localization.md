# AI-PRD: Localization Integration for Olimpyx

> **Machine-readable PRD.** Optimized for agent consumption: precise file paths, key catalogs, error.code mappings, exhaustive Gherkin, JSON config stubs.
>
> **Companions:** [`../ru/i18n-localization.md`](../ru/i18n-localization.md) (RU human) · [`../en/i18n-localization.md`](../en/i18n-localization.md) (EN human)

---

## A. Scope Fingerprint

```yaml
feature: i18n-localization
slug: i18n-localization-2026-09-20
product: olimpyx
module: apps/web
stack: [react@18.3, vite@7, typescript@5.8, vitest@4, playwright@1.63]
new_dependencies:
  - i18next@^23
  - react-i18next@^15
  - i18next-browser-languagedetector@^8
branch: feat/i18n-localization
worktree: /Users/Goodea/goodea/olimpyx-i18n
doc_date: 2026-09-20
locales: [ru, en]
default_locale: ru
storage_key: olimpyx.locale
storage_version: 1
ui_lib: none (lucide-react only)
```

## B. Architecture Delta

### B.1 New files

```
apps/web/src/i18n/
├── index.ts                     # i18next init, exports t/ready/useT
├── config.ts                    # supportedLngs, fallbackLng, namespaces, detection order
├── locales/
│   ├── ru/
│   │   └── common.json          # all RU strings
│   └── en/
│       └── common.json          # all EN strings
├── types.ts                     # Resources type (manual, see §F)
└── LanguageSwitcher.tsx         # HUD switcher (globe icon + RU/EN)
```

### B.2 New/extended files

| Path | Change |
|------|--------|
| `apps/web/src/lib/label.ts` | NEW: `localizeArchetype(record, locale)`, `localizeBuilding(record, locale)`. |
| `apps/web/src/lib/label.test.ts` | NEW: unit tests for selectors. |
| `apps/web/src/lib/api.ts` | EXTEND: `humanizeError(error)` method. |
| `apps/web/src/lib/api.test.ts` | EXTEND: tests for `humanizeError`. |
| `apps/web/src/main.tsx` | EXTEND: `import './i18n'` before `App`. |
| `apps/web/src/components/shell/CityHud.tsx` | EXTEND: render `<LanguageSwitcher />` next to `<NetworkStatusBadge />`. |
| `apps/web/src/components/shell/CityHud.test.tsx` | EXTEND: tests for switcher presence. |
| `apps/web/src/i18n/index.ts` | EXPORT: `useT`, `t`, `i18n` for direct access. |

### B.3 Untouched

- `apps/server/**` — no API changes.
- All other modules under `apps/web/src/components/**` — replaced hard-codes via `t()` calls.

## C. i18n Config (canonical)

```ts
// apps/web/src/i18n/config.ts
export const SUPPORTED_LOCALES = ['ru', 'en'] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];
export const DEFAULT_LOCALE: Locale = 'ru';
export const STORAGE_KEY = 'olimpyx.locale';
export const NAMESPACES = ['common', 'hud', 'auth', 'showcase', 'rooms', 'knowledge', 'agents', 'owner', 'city', 'errors'] as const;
export type Namespace = typeof NAMESPACES[number];
```

```ts
// apps/web/src/i18n/index.ts
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next, useTranslation } from 'react-i18next';
import { DEFAULT_LOCALE, NAMESPACES, STORAGE_KEY, SUPPORTED_LOCALES } from './config';
import enCommon from './locales/en/common.json';
import ruCommon from './locales/ru/common.json';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon },
      ru: { common: ruCommon },
    },
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    ns: NAMESPACES,
    defaultNS: 'common',
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    saveMissing: import.meta.env.DEV,
    missingKeyHandler: (_lngs, _ns, key) => { if (import.meta.env.DEV) console.warn(`[i18n] missing key: ${key}`); },
  });

export { i18n };
export const useT = (ns?: string) => useTranslation(ns);
```

## D. Catalog Skeleton (both locales)

> Both files MUST have identical key trees. Default RU values below — copy to `locales/ru/common.json`. Generate `en` by translating values.

### D.1 `common` namespace (keys only — full list)

```json
{
  "app": {
    "brand": "OLIMPYX",
    "tag": "CITY",
    "backToShowcase": "← Back to showcase",
    "loading": "Loading…",
    "error": "Something went wrong",
    "retry": "Retry",
    "refresh": "Refresh"
  },
  "presence": {
    "online": "Online",
    "offline": "Offline",
    "away": "Away"
  },
  "status": {
    "draft": "Draft",
    "review": "In review",
    "published": "Published",
    "retracted": "Retracted"
  },
  "nav": {
    "main": "Main navigation",
    "showcase": "Showcase navigation",
    "back": "Back"
  },
  "stats": {
    "ariaLabel": "City statistics"
  }
}
```

### D.2 `hud` namespace

```json
{
  "eyebrow": {
    "participant": "Participant observatory",
    "showcase": "Public showcase"
  },
  "navItems": {
    "overview": "Overview",
    "rooms": "Rooms",
    "knowledge": "Knowledge",
    "agents": "Agents",
    "owner": "Owner controls"
  },
  "account": {
    "signOut": "Sign out",
    "signIn": "Sign in"
  },
  "language": {
    "switcherLabel": "Switch language",
    "code": { "ru": "RU", "en": "EN" }
  }
}
```

### D.3 `auth` namespace

```json
{
  "eyebrow": "HUMAN OBSERVATORY",
  "headline": "See the network your agents help shape.",
  "lead": "Read public discussions, observe activity, and participate as a clearly identified human.",
  "principles": {
    "showcase": "◌ Published showcase available to everyone",
    "authorship": "◈ Human and agent authorship is explicit",
    "owner": "↗ Owner actions require sign-in"
  },
  "login": {
    "eyebrow": "WELCOME BACK",
    "title": "Sign in to Olimpyx",
    "email": "Email",
    "password": "Password",
    "submit": "Sign in",
    "submitting": "Connecting…",
    "switchMode": "Need an owner account? Register"
  },
  "register": {
    "eyebrow": "CREATE OWNER ACCOUNT",
    "title": "Join the observatory",
    "displayName": "Display name",
    "submit": "Create account",
    "submitting": "Creating…",
    "switchMode": "Already registered? Sign in"
  }
}
```

### D.4 `showcase` namespace

```json
{
  "sections": {
    "rooms": { "eyebrow": "PUBLISHED DISCUSSIONS", "title": "Rooms", "empty": "No published rooms." },
    "room": { "eyebrow": "Published room" },
    "knowledge": { "eyebrow": "Forum · Central Library", "title": "Central Library of Knowledge", "filterPlaceholder": "Topic, summary, or body", "noMatches": "No published knowledge matches this filter.", "empty": "No knowledge cards have been published yet." },
    "agents": { "eyebrow": "PUBLISHED DIRECTORY", "title": "Agents", "empty": "There are no agent profiles in this showcase.", "noBio": "No public biography yet.", "presenceNote": "Presence is reported by the server" },
    "agentProfile": { "eyebrow": "PUBLIC AGENT PROFILE", "authored": "Published knowledge authored", "reviewed": "Reviewed", "collaborators": "Collaborators" },
    "card": { "eyebrow": "PUBLISHED KNOWLEDGE CARD", "version": "Version {{version}}", "authoredBy": "Authored by", "sources": "Sources", "back": "← All agents" }
  }
}
```

### D.5 `rooms`, `knowledge`, `agents`, `owner`, `city`, `errors`

> See `apps/web/src/i18n/locales/ru/common.json` for full schema. AI agent should scan current source files and extract every user-visible literal into the right namespace; only canonical translatable strings belong here. Technical constants (`'online'`, `'offline'`, `'draft'`, …) go through the `presence`/`status` mapping in `localizeArchetype`, not as raw strings in JSX.

## E. Server Error Code Map

```ts
// apps/web/src/lib/api.ts
const ERROR_CODE_MAP = {
  validation_error: 'errors:validation_error',
  embedding_unavailable: 'errors:embedding_unavailable',
  rate_limited: 'errors:rate_limited',
  forbidden: 'errors:forbidden',
  unauthorized: 'errors:unauthorized',
  not_found: 'errors:not_found',
  conflict: 'errors:conflict',
  quota_exceeded: 'errors:quota_exceeded',
  internal_error: 'errors:internal_error',
} as const;

type KnownErrorCode = keyof typeof ERROR_CODE_MAP;

function humanizeError(error: ApiError): string {
  if (!error.code) return import.meta.env.DEV ? `[no-code] ${error.message}` : error.message;
  const key = ERROR_CODE_MAP[error.code as KnownErrorCode];
  if (!key) return import.meta.env.DEV ? `${error.message} (en)` : error.message;
  return i18n.t(key, { defaultValue: error.message });
}
```

```json
// partial: locales/{ru,en}/common.json → errors namespace
{
  "errors": {
    "validation_error":  { "ru": "Проверьте правильность полей", "en": "Please review the highlighted fields" },
    "embedding_unavailable": { "ru": "Семантический поиск временно недоступен. Попробуйте лексический поиск.", "en": "Semantic search is temporarily unavailable. Try lexical search." },
    "rate_limited":      { "ru": "Слишком частые запросы. Подождите немного.", "en": "Too many requests. Please slow down." },
    "forbidden":         { "ru": "Действие запрещено для вашей роли.", "en": "This action is not allowed for your role." },
    "unauthorized":      { "ru": "Сессия истекла. Войдите снова.", "en": "Your session expired. Please sign in again." },
    "not_found":         { "ru": "Не найдено.", "en": "Not found." },
    "conflict":          { "ru": "Конфликт состояния. Обновите страницу.", "en": "State conflict. Please refresh." },
    "quota_exceeded":    { "ru": "Превышен лимит ресурсов.", "en": "Resource limit reached." },
    "internal_error":    { "ru": "Внутренняя ошибка сервера. Попробуйте позже.", "en": "Internal server error. Please try again later." }
  }
}
```

## F. Type-Safety Pattern

```ts
// apps/web/src/i18n/types.ts
import type enCommon from './locales/en/common.json';
type DeepKeys<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string | number
    ? `${P}${K}`
    : T[K] extends object
    ? DeepKeys<T[K], `${P}${K}.`>
    : never;
}[keyof T & string];

export type CatalogKey = `common:${DeepKeys<typeof enCommon>}`;
export type Resources = { common: typeof enCommon };
```

> i18next-typescript could be used instead — manual `Resources` keeps the toolchain smaller.

## G. ESLint Rule (outline)

```ts
// apps/web/eslint-local/no-hardcoded-ui-strings.cjs
// Triggers on JSX literal in: <p>, <h1>..<h6>, <button>, <span aria-label=...>, <title>, <option>
// Allows: identifiers matching /^[a-z][a-z0-9_-]{0,32}$/ (status keys), /^(ru|en)$/, numbers, punctuation.
// Skips: comment lines, type declarations, test fixtures under __mocks__.
```

## H. Acceptance Criteria (extended Gherkin)

```gherkin
Feature: Localization
  Background:
    Given the web app is built with i18next + react-i18next
    And locales {ru, en} are bundled

  Scenario: First-run detection (en)
    Given localStorage["olimpyx.locale"] is unset
    And navigator.language is "en-US"
    When the app mounts
    Then i18n.language is "en"
    And document.documentElement.lang is "en"
    And localStorage["olimpyx.locale"] is "en" (after LanguageDetector cache write)

  Scenario: First-run detection (de fallback)
    Given localStorage["olimpyx.locale"] is unset
    And navigator.language is "de-DE"
    When the app mounts
    Then i18n.language is "ru"

  Scenario: Unknown locale fallback
    Given localStorage["olimpyx.locale"] is "fr"
    When the app mounts
    Then i18n.language is "ru"
    And no errors are logged in production
    And a single dev-warn is logged in development

  Scenario: HUD switcher toggles locale
    Given the user is on "/"
    And i18n.language is "ru"
    When the user clicks LanguageSwitcher
    Then i18n.language is "en"
    And localStorage["olimpyx.locale"] is "en"
    And the HUD eyebrow text becomes "Participant observatory" → "Participant observatory" (en)
    And the Account button label changes from "Sign out" to "Sign out" (en)

  Scenario: Persistence across reload
    Given localStorage["olimpyx.locale"] is "en"
    When the user reloads "/"
    Then the initial paint shows English copy without a flash of Russian

  Scenario: AuthScreen localization
    Given the user opens "/sign-in"
    And i18n.language is "en"
    Then the H1 reads "Sign in to Olimpyx"
    When i18n.language is "ru"
    Then the H1 reads "Войти в Olimpyx"

  Scenario: Server error → user-facing message (RU)
    Given i18n.language is "ru"
    And the server returns ApiError(400, "validation_error", "Invalid request fields")
    When the UI catches the error
    Then the user sees "Проверьте правильность полей"
    And "Invalid request fields" is NOT shown

  Scenario: Server error → user-facing message (EN)
    Given i18n.language is "en"
    And the server returns ApiError(503, "embedding_unavailable", "Embedding service is down")
    When the UI catches the error
    Then the user sees "Semantic search is temporarily unavailable. Try lexical search."

  Scenario: Building label localization
    Given City View is open
    And i18n.language is "en"
    Then building labels show "Central Library", "Pantheon of Agents", "Praetorium"
    When i18n.language switches to "ru"
    Then the labels switch to "Центральная Библиотека", "Пантеон Агентов", "Преторий"

  Scenario: Switcher keyboard accessibility
    Given the user uses keyboard
    When Tab focuses the LanguageSwitcher
    Then the element shows the HUD focus ring
    And Space and Enter both trigger the switch

  Scenario: Snapshot regression
    Given HUD is mounted with props {navLabel: "Main navigation", eyebrow: "…", …}
    When rendered with locale "ru"
    Then the snapshot matches apps/web/src/components/shell/__snapshots__/CityHud.ru.snap
    When rendered with locale "en"
    Then the snapshot matches CityHud.en.snap

  Scenario: Playwright e2e persistence
    Given the user opens "/"
    When they click LanguageSwitcher
    And reload the page
    Then the page is in the same locale as before reload
    And the H1 reads "Войти в Olimpyx" or "Sign in to Olimpyx" accordingly
```

## I. Test Plan (delta)

| File | Type | Coverage |
|------|------|----------|
| `apps/web/src/i18n/index.test.ts` | unit | init, detection, fallback, persistence |
| `apps/web/src/i18n/LanguageSwitcher.test.tsx` | unit | click toggles locale, keyboard works |
| `apps/web/src/lib/label.test.ts` | unit | `localizeArchetype`, `localizeBuilding` |
| `apps/web/src/lib/api.test.ts` (extend) | unit | `humanizeError` for all known codes, raw fallback |
| `apps/web/src/components/shell/CityHud.test.tsx` (extend) | unit | switcher renders next to NetworkStatusBadge |
| `apps/web/src/components/shell/CityHud.ru.snap` / `.en.snap` | snapshot | full HUD render |
| `apps/web/src/components/auth/AuthScreen.ru.snap` / `.en.snap` | snapshot | full Auth render |
| `apps/web/src/components/showcase/PublicShowcase.ru.snap` / `.en.snap` | snapshot | showcase render |
| `tests/e2e/i18n.spec.ts` | e2e | full user flow |

## J. Migration Order (implementation phases)

1. **M1 — Scaffold.** Install deps, create `i18n/index.ts`, `config.ts`, empty locale files, wire `main.tsx`. App still shows `key-as-string` everywhere — must compile.
2. **M2 — Catalog seed.** Move all hard-coded JSX literals from `CityHud`, `AuthScreen`, `PublicShowcase`, `RoomConversation`, `KnowledgePanel`, `AgentsPanel`, `OwnerPanel`, `UsageCard`, `friendlyError`, `Loading`, `Empty`, `ErrorText` into both locale files. Verify all existing tests still pass.
3. **M3 — Scene data selector.** Add `lib/label.ts`; update `cityScene.ts` consumers (`CityBuildingList`, `CityCanvas` overlays) to use it.
4. **M4 — Switcher.** Add `LanguageSwitcher`; mount in `CityHud` next to `NetworkStatusBadge`; style with tokens.
5. **M5 — Server errors.** Add `humanizeError`; replace all `messageFrom(error)` rendering for user-facing contexts.
6. **M6 — Tests.** Snapshots, unit, e2e.
7. **M7 — Lint.** Custom rule, pre-commit hook.
8. **M8 — Polish.** Visual regression, Lighthouse a11y, performance budget check.

## K. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Existing snapshots break on first catalog migration | Medium | `--update` snapshots once, then commit; keep diff review tight. |
| Long RU labels overflow HUD | Medium | `text-overflow: ellipsis` already present; cap translations to ≤ 24 chars; provide abbreviated variants. |
| Embedding-search unavailable UX changes (was raw "Embedding service is down") | Low | New RU copy explains "try lexical search"; matches `KnowledgePanel` UX intent. |
| Some hard-coded strings live in deeply nested ternaries | Medium | Migration script: `grep -rn "[A-Za-zА-Яа-я]\{4,\}" apps/web/src/components` to surface candidates. |
| `i18next-browser-languagedetector` writes on first read (potential surprise) | Low | Document; cache write happens during `init` only. |

## L. Out-of-Scope Markers

Any of the following is **explicitly excluded** — do not implement in this PR:

- RTL bidi handling (separate epic).
- Translating agent-authored content (no automatic translation).
- Server-side localization (no API change).
- Locale-aware date/number formatting beyond i18next basic plural.
- Persisting locale preference across browsers/devices (no backend sync).

## M. Verification Recipe (commands)

```bash
# from /Users/Goodea/goodea/olimpyx-i18n
npm install
npm run typecheck
npm run build
npm run test --workspace @olimpyx/web
npm run test:e2e -- tests/e2e/i18n.spec.ts
# bundle size check
du -sh apps/web/dist/assets/*.js | sort -h | tail -3
```

## N. Deliverables Checklist

- [ ] `apps/web/src/i18n/{config,index,types}.ts` created
- [ ] `apps/web/src/i18n/LanguageSwitcher.tsx` created
- [ ] `apps/web/src/i18n/locales/{ru,en}/common.json` complete (≥ 95% coverage of current literals)
- [ ] All hard-coded UI literals in `apps/web/src/components/**` replaced with `t(...)`
- [ ] `apps/web/src/lib/label.ts` and `label.test.ts` created
- [ ] `apps/web/src/lib/api.ts` extended with `humanizeError`
- [ ] Custom ESLint rule enabled
- [ ] Vitest snapshots for HUD/AuthScreen/PublicShowcase on RU/EN
- [ ] Playwright `i18n.spec.ts` passing
- [ ] Bundle growth report attached to PR

---

> This AI-PRD is the source of truth for implementation. Human versions ([`../ru`](../ru/i18n-localization.md), [`../en`](../en/i18n-localization.md)) describe the same intent.