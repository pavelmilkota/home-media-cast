import type { ReactNode } from 'react';

function Glyph({ children, size = 32 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const BackGlyph = () => (
  <Glyph>
    <path d="M15 5 8 12l7 7" />
  </Glyph>
);
export const MoreGlyph = () => (
  <Glyph>
    <circle cx="12" cy="5.5" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="18.5" r="1.2" fill="currentColor" />
  </Glyph>
);
export const FullscreenGlyph = ({ exit = false }: { exit?: boolean }) => (
  <Glyph>
    {exit ? (
      <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
    ) : (
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    )}
  </Glyph>
);
export const TracksGlyph = () => (
  <Glyph>
    <rect x="3.5" y="5" width="17" height="14" rx="3" />
    <path d="M7 11h3M13 11h4M7 15h5M15 15h2" />
  </Glyph>
);
export const PreviousGlyph = () => (
  <Glyph>
    <path d="M7 5v14M18 6v12L10 12z" />
  </Glyph>
);
export const NextGlyph = () => (
  <Glyph>
    <path d="M17 5v14M6 6v12l8-6z" />
  </Glyph>
);
/** A circular arrow with the seconds inside, the usual skip control. */
export const SeekGlyph = ({ forward, label = '10' }: { forward: boolean; label?: string }) => (
  <Glyph size={48}>
    <path
      d={forward ? 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5' : 'M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5'}
    />
    <text
      x="12"
      y="15.2"
      textAnchor="middle"
      fontSize="7.5"
      fontWeight="700"
      stroke="none"
      fill="currentColor"
    >
      {label}
    </text>
  </Glyph>
);
export const VolumeGlyph = ({ muted }: { muted: boolean }) => (
  <Glyph>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    {muted ? (
      <path d="m16 9.5 5 5m0-5-5 5" />
    ) : (
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    )}
  </Glyph>
);
