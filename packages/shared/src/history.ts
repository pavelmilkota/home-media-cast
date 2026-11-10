import type { CatalogType } from './catalog.js';

/** One thing played lately, as the frontend sees it. No link, `optionId`, hash or release key. */
export interface PlayedItem {
  /** The movie or episode id (`tt…` or `tt…:season:episode`); replay goes through it. */
  id: string;
  type: CatalogType;
  titleId: string;
  name: string;
  year?: string;
  poster?: string;
  /** Episode label ("S02E05 · Name"). */
  label?: string;
  /** The release that was started. */
  releaseTitle: string;
  resolution?: string;
  quality?: string;
  /** Epoch ms of the last start. */
  playedAt: number;
}

export interface PlaybackHistoryResponse {
  items: PlayedItem[];
}
