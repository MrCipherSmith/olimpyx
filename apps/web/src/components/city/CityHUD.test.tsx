import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CityLegend } from './CityHUD';

describe('CityLegend', () => {
  it('shows the Praetorium entry only when the scene has one', () => {
    const { rerender } = render(<CityLegend onOpen={vi.fn()} />);
    const legend = screen.getByRole('group', { name: 'Key buildings' });
    expect(within(legend).queryByRole('button', { name: 'Praetorium' })).toBeNull();
    const onOpen = vi.fn();
    rerender(<CityLegend onOpen={onOpen} praetorium />);
    fireEvent.click(within(legend).getByRole('button', { name: 'Praetorium' }));
    expect(onOpen).toHaveBeenCalledWith('praetorium');
  });
});
