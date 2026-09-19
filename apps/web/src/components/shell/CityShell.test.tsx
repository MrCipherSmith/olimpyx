import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Route } from '../../lib/navigation';
import { screenFor } from '../../lib/navigation';
import { initialNetworkStatus } from '../../lib/networkStatus';
import { CityHud } from './CityHud';
import { CityShell } from './CityShell';
import { ScreenLayer } from './ScreenLayer';

/** A minimal shell: HUD nav, a building button in the city, and a screen layer per route. */
function Harness({ initial = { view: 'overview' } as Route, dialog = false }) {
  const [route, setRoute] = useState<Route>(initial);
  const screenInfo = screenFor(route);
  const close = () => setRoute({ view: 'overview' });
  return (
    <CityShell
      hud={<CityHud navLabel="Main navigation" eyebrow="Test" network={initialNetworkStatus} activeView={route.view} onNavigate={setRoute} stats={[]} account={null}
        items={[{ view: 'overview', label: 'Overview', icon: '◫' }, { view: 'rooms', label: 'Rooms', icon: '#' }, { view: 'knowledge', label: 'Knowledge', icon: '◈' }]} />}
      city={<button type="button" onClick={() => setRoute({ view: 'knowledge' })}>Central Library</button>}
      screen={screenInfo && <ScreenLayer key={screenInfo.key} kind={screenInfo.kind} title={screenInfo.kind === 'rooms' ? 'Rooms' : 'Central Library of Knowledge'} onBack={close}>
        <label>Search<input /></label><textarea aria-label="Draft" />
        {dialog && <div role="dialog" aria-modal="true" aria-label="Dialog" />}
      </ScreenLayer>}
      screenKey={screenInfo?.key ?? null}
      screenView={screenInfo ? route.view : null}
      onClose={close}
    />
  );
}

afterEach(cleanup);

describe('CityShell screens and focus', () => {
  it('moves focus to the screen heading on open and back to the opening building on close', () => {
    render(<Harness />);
    const building = screen.getByRole('button', { name: 'Central Library' });
    building.focus();
    fireEvent.click(building);
    const heading = screen.getByRole('heading', { level: 1, name: 'Central Library of Knowledge' });
    expect(heading).toHaveFocus();
    fireEvent.click(screen.getByRole('link', { name: 'Back to the city' }));
    expect(screen.queryByRole('heading', { name: 'Central Library of Knowledge' })).toBeNull();
    expect(building).toHaveFocus();
  });

  it('returns focus to the nav item that opened the screen', () => {
    render(<Harness />);
    const rooms = screen.getByRole('link', { name: 'Rooms' });
    rooms.focus();
    fireEvent.click(rooms);
    expect(screen.getByRole('heading', { name: 'Rooms' })).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Rooms' })).toBeNull();
    expect(rooms).toHaveFocus();
  });

  it('on a deep link, opens the screen at once and falls back to that screen’s nav item on close', () => {
    render(<Harness initial={{ view: 'knowledge' }} />);
    expect(screen.getByRole('heading', { name: 'Central Library of Knowledge' })).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('link', { name: 'Knowledge' })).toHaveFocus();
  });

  it('makes the city and HUD inert while a screen covers them', () => {
    const { container } = render(<Harness initial={{ view: 'rooms' }} />);
    expect(container.querySelector('.city-shell-hud')).toHaveAttribute('inert');
    expect(container.querySelector('.city-shell-world')).toHaveAttribute('inert');
    // inert alone hides them: no aria-hidden on an ancestor that may still hold the focus.
    expect(container.querySelector('.city-shell-hud')).not.toHaveAttribute('aria-hidden');
    expect(container.querySelector('.city-shell-world')).not.toHaveAttribute('aria-hidden');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    fireEvent.click(screen.getByRole('link', { name: 'Back to the city' }));
    expect(container.querySelector('.city-shell-hud')).not.toHaveAttribute('inert');
    expect(container.querySelector('.city-shell-world')).not.toHaveAttribute('inert');
  });

  it('does not close on Escape while a dialog is open or while typing a draft', () => {
    const { unmount } = render(<Harness initial={{ view: 'rooms' }} dialog />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'Rooms' })).toBeInTheDocument();
    unmount();
    render(<Harness initial={{ view: 'rooms' }} />);
    const draft = screen.getByRole('textbox', { name: 'Draft' });
    fireEvent.keyDown(draft, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'Rooms' })).toBeInTheDocument();
    const search = screen.getByRole('textbox', { name: 'Search' });
    fireEvent.keyDown(search, { key: 'Escape' }); // an empty field does not hold anything to lose
    expect(screen.queryByRole('heading', { name: 'Rooms' })).toBeNull();
  });

  it('marks the current destination and keeps each nav link named by its label, with the count as description', () => {
    render(<CityHud navLabel="Main navigation" eyebrow="Test" network={initialNetworkStatus} activeView="rooms" onNavigate={() => {}} account={null}
      stats={[{ label: 'Rooms', value: 3 }, { label: 'Agents', value: null }]}
      items={[{ view: 'rooms', label: 'Rooms', icon: '#', badge: '3', badgeLabel: '3 rooms' }, { view: 'knowledge', label: 'Knowledge', icon: '◈', badge: null }]} />);
    const rooms = screen.getByRole('link', { name: 'Rooms' });
    expect(rooms).toHaveAttribute('aria-current', 'page');
    expect(rooms).toHaveAccessibleDescription('3 rooms');
    expect(screen.getByRole('link', { name: 'Knowledge' })).not.toHaveAccessibleDescription();
    // Unknown stats are hidden rather than shown as 0.
    expect(screen.getByText('Rooms', { selector: 'dt' })).toBeInTheDocument();
    expect(screen.queryByText('Agents', { selector: 'dt' })).toBeNull();
  });
});
