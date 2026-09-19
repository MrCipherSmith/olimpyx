import { useMemo } from 'react';
import type { InhabitantActivityInput } from '../city/inhabitants';

/** Content key of agent↔room links: order and duplicates do not change which avenue an agent walks. */
export function activityKey(activity: readonly InhabitantActivityInput[]): string {
  return JSON.stringify([...new Set(activity.map(link => JSON.stringify([link.agentId, link.roomId])))].sort());
}

/**
 * The same array reference until the links actually change: a 5s room poll that returns new message
 * objects (same senders) must not look like new activity to the city's inhabitant planner.
 */
export function useStableActivity<T extends readonly InhabitantActivityInput[]>(activity: T): T {
  const key = activityKey(activity);
  // Keyed by content on purpose: `activity` is read only when the key changes.
  return useMemo(() => activity, [key]);
}
