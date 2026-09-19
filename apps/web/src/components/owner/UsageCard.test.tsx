import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveLimits, OlimpyxApi, OwnerUsage } from '../../lib/api';
import { UsageCard } from './UsageCard';

const zeroCounters = { messages: 0, replies_in_other_threads: 0, own_threads_resolved: 0, knowledge_cards: 0, knowledge_versions: 0, reviews_given: 0, tasks_completed_for_others: 0 };
const limitsPayload: EffectiveLimits = { actions: {}, direct_message_pair: { window_sec: 3600, limit: 10 }, capacity: { agents_per_owner: 10, enrollment_tokens_per_owner: 5, sessions_per_agent: 3, open_tasks_per_assignee: 20 } };

function usagePayload(messages7d: number): OwnerUsage {
  return {
    owner: { owner_id: 'own_1', window: {}, counters: { days_7: { ...zeroCounters, messages: messages7d }, days_30: zeroCounters } },
    agents: [],
  };
}

function apiWith(usageImpl: () => Promise<OwnerUsage>): OlimpyxApi {
  return { usage: usageImpl, limits: () => Promise.resolve(limitsPayload) } as unknown as OlimpyxApi;
}

describe('UsageCard stale-response guard', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('keeps the result of the most recently triggered load even if an earlier one resolves later', async () => {
    let resolveFirst!: (value: OwnerUsage) => void;
    const firstLoad = new Promise<OwnerUsage>(resolve => { resolveFirst = resolve; });
    let calls = 0;
    const api = apiWith(() => { calls += 1; return calls === 1 ? firstLoad : Promise.resolve(usagePayload(99)); });

    render(<UsageCard api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/99 messages/)).toBeInTheDocument();

    // The slow first load now resolves with a different, older payload — it must be ignored.
    resolveFirst(usagePayload(5));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText(/99 messages/)).toBeInTheDocument();
    expect(screen.queryByText(/^5 messages/)).not.toBeInTheDocument();
  });

  it('does not throw when the component unmounts while a load is still in flight', async () => {
    let resolveUsage!: (value: OwnerUsage) => void;
    const pending = new Promise<OwnerUsage>(resolve => { resolveUsage = resolve; });
    const api = apiWith(() => pending);

    const { unmount } = render(<UsageCard api={api} />);
    unmount();
    resolveUsage(usagePayload(1));
    await Promise.resolve();
    await Promise.resolve();
    // Reaching here without an unhandled exception is the assertion.
  });
});
