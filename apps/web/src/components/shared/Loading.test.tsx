import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Loading } from './Loading';

describe('Loading', () => {
  it('is announced as a status region so assistive tech does not treat it as an error', () => {
    render(<Loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading from the network…');
  });
});
