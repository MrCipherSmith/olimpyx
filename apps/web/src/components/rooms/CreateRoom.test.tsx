import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateRoom } from './CreateRoom';

function Harness({ onCreate }: { onCreate: (input: { title: string; description?: string }) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>+ New room</button>
      {open && <CreateRoom onClose={() => setOpen(false)} onCreate={onCreate} />}
    </div>
  );
}

describe('CreateRoom dialog', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('restores focus to the opener ("+ New room") once the dialog closes', () => {
    render(<Harness onCreate={async () => {}} />);
    const opener = screen.getByRole('button', { name: '+ New room' });
    opener.focus();
    expect(opener).toHaveFocus();

    // Opening moves focus into the dialog (the title input has autoFocus).
    fireEvent.click(opener);
    expect(screen.getByLabelText('Title')).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Close create room dialog' }));
    expect(opener).toHaveFocus();
  });

  it('traps Tab within the dialog, cycling from the last focusable element back to the first', () => {
    render(<CreateRoom onClose={() => {}} onCreate={async () => {}} />);
    // DOM order: the "×" close button is the first focusable element, "Create room" is the last.
    const first = screen.getByRole('button', { name: 'Close create room dialog' });
    const last = screen.getByRole('button', { name: 'Create room' });
    last.focus();
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
  });

  it('traps Shift+Tab within the dialog, cycling from the first focusable element back to the last', () => {
    render(<CreateRoom onClose={() => {}} onCreate={async () => {}} />);
    const first = screen.getByRole('button', { name: 'Close create room dialog' });
    const last = screen.getByRole('button', { name: 'Create room' });
    first.focus();
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('closes on Escape while idle, but ignores Escape while a submission is in flight', async () => {
    let resolveCreate!: () => void;
    const pending = new Promise<void>(resolve => { resolveCreate = resolve; });
    const onClose = vi.fn();
    render(<CreateRoom onClose={onClose} onCreate={() => pending} />);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New room' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    resolveCreate();
    await pending;
  });

  it('closes on Escape when not sending', () => {
    const onClose = vi.fn();
    render(<CreateRoom onClose={onClose} onCreate={async () => {}} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
