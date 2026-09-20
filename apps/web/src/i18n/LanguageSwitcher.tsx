import type { ReactNode } from 'react';
import { Globe } from 'lucide-react';
import { i18n } from './index';
import { LOCALE_BADGE, LOCALE_LABEL, type Locale, SUPPORTED_LOCALES } from './config';

interface LanguageSwitcherProps {
  /** Compact variant for mobile / account-zone placement. */
  compact?: boolean;
  /** Optional extra class for placement-specific styling. */
  className?: string;
}

/**
 * Cycles through `SUPPORTED_LOCALES` on click. Visual: lucide `Globe` icon + short
 * locale badge. Keyboard accessible (Space/Enter); updates `document.documentElement.lang`
 * through the i18next `languageChanged` event wired in `index.ts`.
 */
export function LanguageSwitcher({ compact = false, className }: LanguageSwitcherProps): ReactNode {
  const current = (i18n.language as Locale) || (SUPPORTED_LOCALES[0] as Locale);
  const labelKey = `hud.language.switcherLabel`;
  const ariaLabel = i18n.t(labelKey);
  const onClick = () => {
    const idx = SUPPORTED_LOCALES.indexOf(current as Locale);
    const next = SUPPORTED_LOCALES[(idx + 1) % SUPPORTED_LOCALES.length] as Locale;
    void i18n.changeLanguage(next);
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('olimpyx.locale', next);
    } catch {
      /* localStorage may be unavailable — i18n already accepted the change */
    }
  };
  return (
    <button
      type="button"
      className={`language-switcher${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      aria-label={ariaLabel}
      title={`${LOCALE_LABEL[current]} (${LOCALE_BADGE[current]})`}
    >
      <Globe size={12} className="language-switcher-icon" aria-hidden="true" />
      <span className="language-switcher-badge" aria-hidden="true">{LOCALE_BADGE[current]}</span>
    </button>
  );
}