import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { OlimpyxApi, Profile } from '../../lib/api';
import { AgentProfile } from './AgentProfile';

// Minimal fake I18n provider — the component only ever calls `t('agents.*')`.
const translations: Record<string, string> = {
  'agents.profile.back': '← All agents',
  'agents.eyebrowProfile': 'AGENT PROFILE',
  'agents.profile.noBio': 'No bio yet.',
  'agents.lastSeen': 'Last seen {{ago}}',
  'agents.contributionsNote': 'Knowledge contributions appear only where authorship or review data explicitly identifies this agent.',
  'agents.currentlyIn': 'Currently in',
  'presence.online': 'online',
  'presence.offline': 'offline',
};

vi.mock('../../i18n', () => ({
  useT: () => ({ t: (key: string, vars?: Record<string, string>) => {
    const template = translations[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? '');
  } })
}));

const stubApi = {} as OlimpyxApi;

const base: Profile = {
  agent_id: 'agt_1',
  name: 'Prometheus',
  role: 'AI visionary',
  bio: 'bio',
  interests: [],
  capabilities: [],
  presence: 'online',
  last_seen_at: new Date().toISOString(),
  profile_revision: 1,
};

beforeEach(() => {
  // jsdom has no history.pushState listener wiring for the agent profile nav.
  window.history.pushState = vi.fn();
  window.dispatchEvent = vi.fn();
});

afterEach(cleanup);

describe('AgentProfile — current activity (F-03)', () => {
  it('renders "Currently in" link to the room when activity is fresh and online', () => {
    const profile: Profile = {
      ...base,
      current_activity: { kind: 'room', location_ref: 'rom_42', note: 'drafting a memo', updated_at: new Date().toISOString() },
    };
    render(<AgentProfile api={stubApi} selected={profile} />);
    const link = screen.getByTestId('agent-current-activity').querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('view=rooms');
    expect(link!.getAttribute('href')).toContain('room=rom_42');
    expect(link!.textContent).toContain('drafting a memo');
  });

  it('renders a knowledge-card link when activity is kind=knowledge', () => {
    const profile: Profile = {
      ...base,
      current_activity: { kind: 'knowledge', location_ref: 'knw_99', note: 'CLT deep-dive', updated_at: new Date().toISOString() },
    };
    render(<AgentProfile api={stubApi} selected={profile} />);
    const link = screen.getByTestId('agent-current-activity').querySelector('a');
    expect(link!.getAttribute('href')).toContain('view=knowledge');
    expect(link!.getAttribute('href')).toContain('card=knw_99');
  });

  it('falls back to "in the city lobby" when online but no fresh activity is set', () => {
    const profile: Profile = { ...base, current_activity: null };
    render(<AgentProfile api={stubApi} selected={profile} />);
    const link = screen.getByTestId('agent-current-activity').querySelector('a');
    // `view=overview` is the implicit default and produces no query string;
    // the navigation helper collapses it to the pathname.
    expect(link!.getAttribute('href')).not.toContain('view=rooms');
    expect(link!.getAttribute('href')).not.toContain('view=knowledge');
    expect(link!.textContent).toContain('lobby');
  });

  it('omits the activity block when the agent is offline', () => {
    const profile: Profile = { ...base, presence: 'offline', current_activity: null };
    render(<AgentProfile api={stubApi} selected={profile} />);
    expect(screen.queryByTestId('agent-current-activity')).toBeNull();
  });

  it('clicking the link pushes history and dispatches a popstate event', () => {
    const profile: Profile = {
      ...base,
      current_activity: { kind: 'room', location_ref: 'rom_42', note: '', updated_at: new Date().toISOString() },
    };
    render(<AgentProfile api={stubApi} selected={profile} />);
    const link = screen.getByTestId('agent-current-activity').querySelector('a')!;
    fireEvent.click(link);
    expect(window.history.pushState).toHaveBeenCalledWith(null, '', expect.stringContaining('room=rom_42'));
    expect(window.dispatchEvent).toHaveBeenCalled();
  });
});
