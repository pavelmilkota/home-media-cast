/**
 * When the app runs in an iframe (a Home Assistant dashboard card) the iframe can be taller than
 * what the phone shows, so a bar pinned to its bottom edge sits off screen until the host page is
 * scrolled to the end. An IntersectionObserver without a root reports the part of this frame that
 * is visible in the top-level viewport, even across origins; the hidden part is published as
 * `--embed-bottom-inset` so the bottom bar can lift itself above it.
 */
export function trackEmbeddedBottomInset(): () => void {
  if (window.self === window.top || typeof IntersectionObserver === 'undefined') return () => {};
  const root = document.documentElement;
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:100%;opacity:0;pointer-events:none';
  document.body.append(probe);
  const observer = new IntersectionObserver(
    (entries) => {
      const last = entries.at(-1);
      if (!last?.isIntersecting) return;
      const hidden = window.innerHeight - last.intersectionRect.bottom;
      const inset = Math.min(Math.max(0, Math.round(hidden)), window.innerHeight / 2);
      root.style.setProperty('--embed-bottom-inset', `${inset}px`);
    },
    { threshold: Array.from({ length: 101 }, (_, i) => i / 100) },
  );
  observer.observe(probe);
  return () => {
    observer.disconnect();
    probe.remove();
    root.style.removeProperty('--embed-bottom-inset');
  };
}
