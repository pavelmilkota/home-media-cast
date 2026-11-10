import type { CatalogType, HandoffPickSource } from '@home-media-cast/shared';
import { useSyncExternalStore } from 'react';

/**
 * A handoff that could not pick the source by itself (409 `handoff_pick_source`): the title page
 * opens its picker for `videoId` and says why. In memory only; it is gone after one use.
 */
export interface PendingPick extends HandoffPickSource {
  /** Where the session is going: this device, or the TV. */
  direction: 'here' | 'tv';
  /** The server's reason (for example "this device cannot play it"), if it gave one. */
  reason?: string;
}

let pending: PendingPick | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const handoffPick = {
  get: (): PendingPick | undefined => pending,
  set(next: PendingPick | undefined): void {
    pending = next;
    emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const usePendingPick = (): PendingPick | undefined =>
  useSyncExternalStore(handoffPick.subscribe, handoffPick.get);

/** The catalog id of a title from a video id: `tt1:2:3` is episode 3 of season 2 of `tt1`. */
export const titleIdOf = (videoId: string): string => videoId.split(':')[0] ?? videoId;

export const isPickType = (t: string): t is CatalogType => t === 'movie' || t === 'series';
