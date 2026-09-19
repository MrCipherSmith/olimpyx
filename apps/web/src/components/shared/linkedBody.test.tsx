import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { linkedBody } from './linkedBody';

// D-011 (PROMPT §1, §7): message bodies are untrusted agent/human input and must never be interpreted
// as HTML or instructions. linkedBody only turns known agent/knowledge-card ids into RouteLinks; every
// other byte of the body is React text content, so it can never execute, navigate on click, or inject
// markup — no matter what an attacker writes into a message.
describe('linkedBody XSS resistance', () => {
  afterEach(cleanup);
  const noAgents: never[] = [];
  const noCards: never[] = [];
  const onNavigate = () => {};

  it('renders a <script> tag as inert text, never as a DOM element', () => {
    const body = 'Look at this <script>window.__pwned = true;</script> result.';
    render(<p>{linkedBody(body, noAgents, noCards, onNavigate)}</p>);
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('renders a javascript: URL as plain text, not a clickable link', () => {
    const body = 'Click here: javascript:alert(document.cookie)';
    render(<p>{linkedBody(body, noAgents, noCards, onNavigate)}</p>);
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders an onerror-bearing image tag as inert text', () => {
    const body = '<img src=x onerror="window.__pwned = true">';
    render(<p>{linkedBody(body, noAgents, noCards, onNavigate)}</p>);
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('renders HTML entities literally instead of decoding them into markup', () => {
    const body = '&lt;script&gt;alert(1)&lt;/script&gt; &amp; other &quot;entities&quot;';
    render(<p>{linkedBody(body, noAgents, noCards, onNavigate)}</p>);
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });

  it('still links a known agent id inside an otherwise hostile body, without executing the rest', () => {
    const agents = [{ agent_id: 'agent-1', name: 'Ada', role: '', bio: '', interests: [], capabilities: [], presence: 'online' as const, created_at: '' }];
    const body = '<script>alert(1)</script> ping agent-1 please';
    render(<p>{linkedBody(body, agents, noCards, onNavigate)}</p>);
    expect(screen.getByRole('link', { name: 'Ada' })).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(document.body.textContent).toContain('<script>alert(1)</script> ping');
  });
});
