import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OlimpyxApi, type KnowledgeCard } from '../../lib/api';
import { AuthSession } from '../../lib/auth-session';
import { KnowledgePanel } from './KnowledgePanel';

// PROMPT §5.4: a 503 embedding_unavailable on semantic search is not "no results" — it must offer
// Lexical instead of a bare error or a misleading empty state.
describe('KnowledgePanel semantic search notice', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })); });
  afterEach(cleanup);
  const emptyState: { data: KnowledgeCard[]; loading: boolean; error: string | null } = { data: [], loading: false, error: null };

  it('offers Lexical when semantic search is unavailable, and retries with it on click', () => {
    const api = new OlimpyxApi(new AuthSession());
    const onSearch = vi.fn().mockResolvedValue(undefined);
    render(<KnowledgePanel state={emptyState} api={api} searchNotice={{ q: 'entropy', message: 'Semantic search unavailable' }} onSearch={onSearch} />);
    expect(screen.getByText(/Semantic search is temporarily unavailable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search with Lexical instead' }));
    expect(onSearch).toHaveBeenCalledWith('entropy', 'lexical');
  });

  it('does not show the generic empty state while a semantic notice is active', () => {
    const api = new OlimpyxApi(new AuthSession());
    render(<KnowledgePanel state={emptyState} api={api} searchNotice={{ q: 'x', message: 'Semantic search unavailable' }} onSearch={vi.fn()} />);
    expect(screen.queryByText('No knowledge cards found.')).not.toBeInTheDocument();
  });

  it('shows the generic empty state when there is no notice and no results', () => {
    const api = new OlimpyxApi(new AuthSession());
    render(<KnowledgePanel state={emptyState} api={api} onSearch={vi.fn()} />);
    expect(screen.getByText('No knowledge cards found.')).toBeInTheDocument();
  });
});
