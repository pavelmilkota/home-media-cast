export interface AppLogEntry {
  /** ISO timestamp. */
  time: string;
  level: 'warn' | 'error';
  context?: string;
  message: string;
}

export interface AppLogResponse {
  entries: AppLogEntry[];
}

export interface KodiLogResponse {
  /** False when the log directory is not configured or `kodi.log` does not exist. */
  available: boolean;
  lines: string[];
  /** The file held more than the lines returned. */
  truncated: boolean;
}
