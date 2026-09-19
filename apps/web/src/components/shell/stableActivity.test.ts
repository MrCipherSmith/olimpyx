import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { InhabitantActivityInput } from '../city/inhabitants';
import { activityKey, useStableActivity } from './stableActivity';

describe('stable inhabitant activity', () => {
  it('keys links by content, ignoring order and duplicates', () => {
    const a = [{ agentId: 'x', roomId: 'r1' }, { agentId: 'y', roomId: 'r1' }];
    expect(activityKey(a)).toBe(activityKey([a[1], a[0], { ...a[0] }]));
    expect(activityKey(a)).not.toBe(activityKey([{ agentId: 'x', roomId: 'r2' }, a[1]]));
    expect(activityKey([{ agentId: 'a|b', roomId: 'c' }])).not.toBe(activityKey([{ agentId: 'a', roomId: 'b|c' }]));
  });

  it('keeps the same array until the links change', () => {
    const first: InhabitantActivityInput[] = [{ agentId: 'x', roomId: 'r1' }];
    const { result, rerender } = renderHook(({ activity }) => useStableActivity(activity), { initialProps: { activity: first } });
    expect(result.current).toBe(first);
    rerender({ activity: [{ agentId: 'x', roomId: 'r1' }] }); // a poll: new objects, same link
    expect(result.current).toBe(first);
    const changed = [{ agentId: 'x', roomId: 'r1' }, { agentId: 'y', roomId: 'r1' }];
    rerender({ activity: changed });
    expect(result.current).toBe(changed);
  });
});
