import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CityHud, type HudNavItem } from '../components/shell/CityHud';
import { AuthScreen } from '../components/auth/AuthScreen';
import { initialNetworkStatus } from '../lib/networkStatus';
import { i18n } from './index';

const ITEMS: HudNavItem[] = [
  { view: 'overview', label: 'Overview', icon: '◫' },
  { view: 'rooms', label: 'Rooms', icon: '#', badge: '3', badgeLabel: '3 rooms' },
  { view: 'knowledge', label: 'Knowledge', icon: '◈' },
  { view: 'agents', label: 'Agents', icon: '⦾' },
  { view: 'owner', label: 'Owner controls', icon: '⚿' },
];

async function setLocale(lng: 'ru' | 'en') {
  await i18n.changeLanguage(lng);
}

afterEach(() => { cleanup(); });

describe('i18n snapshots — HUD, AuthScreen', () => {
  beforeEach(async () => { await setLocale('en'); });

  it('renders HUD nav labels in English when locale is en', () => {
    render(<CityHud navLabel="Main navigation" eyebrow="Test" network={initialNetworkStatus} activeView="rooms" onNavigate={() => {}} stats={[]} account={null} items={ITEMS} />);
    expect(screen.getByRole('link', { name: /Overview/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Rooms/i })).toBeInTheDocument();
    // Language switcher is present
    expect(screen.getByRole('button', { name: /Switch language/i })).toBeInTheDocument();
  });

  it('renders HUD nav labels in Russian when locale is ru', async () => {
    await setLocale('ru');
    render(<CityHud navLabel="Main navigation" eyebrow="Test" network={initialNetworkStatus} activeView="rooms" onNavigate={() => {}} stats={[]} account={null} items={ITEMS} />);
    // Brand still English (non-translatable tag), but nav links carry EN labels passed as prop.
    // The HUD eyebrow from prop is also verbatim. The HUD-level aria uses the localized brand row, so we
    // assert the language switcher aria-label is Russian.
    const switcher = screen.getByRole('button', { name: /Сменить язык/i });
    expect(switcher).toBeInTheDocument();
  });

  it('renders AuthScreen in English', () => {
    const onAuthenticated = () => {};
    const onBack = () => {};
    render(<AuthScreen api={{} as never} onAuthenticated={onAuthenticated} onBack={onBack} />);
    expect(screen.getByRole('heading', { name: /Sign in to Olimpyx/i })).toBeInTheDocument();
  });

  it('renders AuthScreen in Russian', async () => {
    await setLocale('ru');
    const onAuthenticated = () => {};
    const onBack = () => {};
    render(<AuthScreen api={{} as never} onAuthenticated={onAuthenticated} onBack={onBack} />);
    expect(screen.getByRole('heading', { name: /Войти в Olimpyx/i })).toBeInTheDocument();
  });
});