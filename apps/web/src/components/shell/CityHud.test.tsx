import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialNetworkStatus } from '../../lib/networkStatus';
import { CityHud, type HudNavItem } from './CityHud';

/** Matches `(max-width: Npx)` / `(min-width: Npx)` queries (and their combination) against a fake viewport
 * width, the same way DiveFlow.test.tsx stubs `matchMedia` for a single query. */
function stubViewportWidth(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = query.match(/max-width:\s*(\d+)px/);
    const min = query.match(/min-width:\s*(\d+)px/);
    const matches = (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
    return { matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  });
}

const items: HudNavItem[] = [
  { view: 'overview', label: 'Overview', icon: '◫', badge: '3D', badgeLabel: 'The city map' },
  { view: 'rooms', label: 'Rooms', icon: '#', badge: '3', badgeLabel: '3 rooms' },
  { view: 'agents', label: 'Agents', icon: '⦾' },
  { view: 'knowledge', label: 'Knowledge', icon: '◈' },
  { view: 'owner', label: 'Owner controls', icon: '⚿' },
];
const guestItems = items.filter(item => item.view !== 'owner');

function renderHud(overrides: Partial<Parameters<typeof CityHud>[0]> = {}) {
  return render(<CityHud navLabel="Main navigation" eyebrow="Test" network={initialNetworkStatus} activeView="rooms" onNavigate={vi.fn()} stats={[]} account={null} items={items} {...overrides} />);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CityHud responsive navigation (PROMPT §7)', () => {
  it('desktop and tablet: shows the HUD nav list, no tab bar', () => {
    stubViewportWidth(1024);
    renderHud();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(document.querySelector('.tab-bar')).toBeNull();

    cleanup();
    stubViewportWidth(768);
    renderHud();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(document.querySelector('.tab-bar')).toBeNull();
  });

  it('phone: renders a bottom tab bar instead of the HUD nav list', () => {
    stubViewportWidth(390);
    renderHud();
    const tabBar = document.querySelector('.tab-bar');
    expect(tabBar).not.toBeNull();
    expect(tabBar).toHaveAttribute('aria-label', 'Main navigation');
    ['Overview', 'Rooms', 'Agents', 'Knowledge', 'Owner controls'].forEach(label => {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    });
  });

  it('phone: exactly one primary nav is in the document, and it carries the given label', () => {
    stubViewportWidth(320);
    renderHud({ navLabel: 'Showcase navigation', items: guestItems });
    const navs = screen.getAllByRole('navigation', { name: 'Showcase navigation' });
    expect(navs).toHaveLength(1);
    expect(navs[0]).toHaveClass('tab-bar');
  });

  it('phone: the current tab carries aria-current, others do not', () => {
    stubViewportWidth(390);
    renderHud({ activeView: 'agents' });
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Rooms' })).not.toHaveAttribute('aria-current');
  });

  it('phone: clicking a tab navigates to its view', () => {
    stubViewportWidth(390);
    const onNavigate = vi.fn();
    renderHud({ onNavigate });
    fireEvent.click(screen.getByRole('link', { name: 'Knowledge' }));
    expect(onNavigate).toHaveBeenCalledWith({ view: 'knowledge' });
  });

  it('phone: the owner tab is absent for a guest (no Owner controls item)', () => {
    stubViewportWidth(390);
    renderHud({ navLabel: 'Showcase navigation', items: guestItems, account: <button>Sign in</button> });
    expect(screen.queryByRole('link', { name: 'Owner controls' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
