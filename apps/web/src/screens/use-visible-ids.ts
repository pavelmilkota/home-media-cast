import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The ids of the elements (marked with `data-option-id`) that are on screen right now and have
 * stayed there for `dwellMs`, so a fast scroll past a long list does not count them. Where there is
 * no `IntersectionObserver` nothing is ever visible. Returns the set and a ref for each element.
 */
export function useVisibleIds(dwellMs = 300) {
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());
  const observer = useRef<IntersectionObserver | undefined>(undefined);
  const elements = useRef(new Set<Element>());

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const show = (id: string, on: boolean) =>
      setVisible((prev) => {
        if (prev.has(id) === on) return prev;
        const next = new Set(prev);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      });
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset['optionId'];
          if (!id) continue;
          clearTimeout(timers.get(id));
          if (entry.isIntersecting)
            timers.set(
              id,
              setTimeout(() => show(id, true), dwellMs),
            );
          else show(id, false);
        }
      },
      { rootMargin: '100px' },
    );
    observer.current = io;
    for (const el of elements.current) io.observe(el);
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      io.disconnect();
      observer.current = undefined;
    };
  }, [dwellMs]);

  const ref = useCallback((el: Element | null) => {
    if (!el) return;
    elements.current.add(el);
    observer.current?.observe(el);
  }, []);

  return { visible, ref };
}
