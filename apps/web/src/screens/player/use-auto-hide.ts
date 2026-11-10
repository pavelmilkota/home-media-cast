import { useCallback, useEffect, useRef, useState } from 'react';

/** Controls fade out this long after the last interaction while the video plays. */
export const HIDE_AFTER_MS = 3500;
/** Pointer movement fires constantly; it reveals at most this often. */
const MOVE_THROTTLE_MS = 250;

/**
 * Whether the player's controls show. They hide `HIDE_AFTER_MS` after the last interaction while
 * `playing`, and stay up whenever `hold` is true (paused, an error, a blocked autoplay, an open
 * menu or sheet, a seek in progress). Tapping the picture toggles them (`toggle`); pointer movement
 * (a mouse's, not a finger's) and any key press bring them back.
 */
export function useAutoHide({ playing, hold }: { playing: boolean; hold: boolean }) {
  const [visible, setVisible] = useState(true);
  // Bumped by every interaction, so the timer starts over.
  const [touched, setTouched] = useState(0);
  const visibleRef = useRef(true);
  visibleRef.current = visible;
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const lastMove = useRef(0);

  useEffect(() => {
    if (!playing || hold) {
      setVisible(true);
      return;
    }
    const timer = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [playing, hold, touched]);

  const reveal = useCallback(() => {
    setVisible(true);
    setTouched((n) => n + 1);
  }, []);

  /** A tap on the picture: hides the controls, or shows them. Never plays or pauses. */
  const toggle = useCallback(() => {
    if (!visibleRef.current) reveal();
    else if (!holdRef.current) setVisible(false);
  }, [reveal]);

  useEffect(() => {
    const onMove = (e: Event) => {
      // A finger jitters during a tap: that move would reveal the controls just before the tap's
      // click toggles them away again. Touch and pen have the tap; only a mouse reveals by moving.
      const type = (e as PointerEvent).pointerType;
      if (type === 'touch' || type === 'pen') return;
      const now = Date.now();
      if (now - lastMove.current < MOVE_THROTTLE_MS) return;
      lastMove.current = now;
      reveal();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('keydown', reveal);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('keydown', reveal);
    };
  }, [reveal]);

  return { visible, reveal, toggle };
}
