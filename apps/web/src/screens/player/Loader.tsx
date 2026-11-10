/**
 * The wait in the middle of the picture: a large ring with a label under it, for a seek or a stall.
 * It fades in after a short delay (see `player-loader` in styles.css) so a wait too short to notice
 * does not flash it, and it sits above the skip buttons so they stay in reach, and it never takes a tap: the picture and the bars under it keep working.
 * With reduced motion the ring pulses instead of turning.
 */
export function Loader({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="player-loader"
      className="player-loader pointer-events-none absolute inset-0 z-10 grid place-content-center justify-items-center gap-3 pb-56"
    >
      <div className="grid justify-items-center gap-3 rounded-3xl bg-black/60 px-8 py-6 text-white shadow-xl backdrop-blur-sm">
        <svg
          viewBox="0 0 48 48"
          aria-hidden="true"
          className="size-16 animate-spin motion-reduce:animate-pulse"
          fill="none"
          strokeWidth="4.5"
          strokeLinecap="round"
        >
          <circle cx="24" cy="24" r="19" stroke="currentColor" opacity="0.25" />
          <path d="M24 5a19 19 0 0 1 19 19" stroke="currentColor" />
        </svg>
        <span className="text-lg font-medium">{label}</span>
      </div>
    </div>
  );
}
