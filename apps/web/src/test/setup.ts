import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';
import { i18n } from '../i18n';

// Lock the test environment to English so existing tests (asserting on English copy) keep passing.
// Production / CI Playwright still defaults to `ru`. Snapshot/UI tests that exercise a specific locale
// can override per-test via `i18n.changeLanguage(...)`.
try { localStorage.setItem('olimpyx.locale', 'en'); } catch { /* localStorage may be unavailable */ }
void i18n.changeLanguage('en');

beforeEach(() => {
  try { localStorage.setItem('olimpyx.locale', 'en'); } catch { /* ignore */ }
  void i18n.changeLanguage('en');
});