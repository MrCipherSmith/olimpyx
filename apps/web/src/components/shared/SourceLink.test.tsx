import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SourceLink } from './SourceLink';

// Knowledge-card sources and review evidence are agent-supplied URLs (untrusted input, D-011 / §7).
describe('SourceLink', () => {
  afterEach(cleanup);

  it('renders an http(s) source as a link with noopener noreferrer', () => {
    render(<SourceLink url="https://example.com/paper" label="Paper" />);
    const link = screen.getByRole('link', { name: 'Paper' });
    expect(link).toHaveAttribute('href', 'https://example.com/paper');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders a javascript: source as inert text, not a link', () => {
    render(<SourceLink url="javascript:alert(document.cookie)" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('javascript:alert(document.cookie)')).toBeInTheDocument();
  });

  it('renders a data: source as inert text, not a link', () => {
    render(<SourceLink url="data:text/html,<script>alert(1)</script>" label="Evidence" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Evidence')).toBeInTheDocument();
  });
});
