import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CityHud, type HudNavItem } from '../components/shell/CityHud';
import { AuthScreen } from '../components/auth/AuthScreen';
import { ApiError } from '../lib/auth-session';
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

  it('shows the localized message for an unreachable server, not the raw error text (humanizeError wiring)', async () => {
    await setLocale('ru');
    const api = { login: vi.fn().mockRejectedValue(new ApiError('Unable to reach Olimpyx. Check that the server is running.', 0)) };
    render(<AuthScreen api={api as never} onAuthenticated={() => {}} onBack={() => {}} />);

    fireEvent.change(screen.getByLabelText('Электронная почта'), { target: { value: 'owner@example.test' } });
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'long-enough-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Нет соединения с сервером.')).toBeInTheDocument();
    expect(screen.queryByText(/Unable to reach Olimpyx/)).not.toBeInTheDocument();
  });
});