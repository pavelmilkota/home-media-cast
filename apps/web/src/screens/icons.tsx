const glyph = (d: string) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path
      d={d}
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

export const PlayIcon = () => glyph('M7 5v14l12-7Z');
export const PauseIcon = () => glyph('M7 5h3.5v14H7ZM13.5 5H17v14h-3.5Z');
export const StopIcon = () => glyph('M6.5 6.5h11v11h-11Z');
