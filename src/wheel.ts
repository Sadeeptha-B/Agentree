import { useEffect, useRef, useState } from "react";

/**
 * Wheel handling for a pan-and-zoom canvas, attached natively.
 *
 * React registers `onWheel` as a passive listener, so its `preventDefault()`
 * can't stop the browser scrolling whatever scrolls around the canvas: a zoom
 * then also moves the page under the pointer. A non-passive listener on the
 * canvas itself can. Scrolling anywhere else is left alone.
 *
 * Returns a callback ref for the element: a canvas that mounts later (after
 * its data loads) still gets the listener, and one that unmounts drops it.
 */
export function useCanvasWheel<T extends Element>(onWheel: (e: WheelEvent, el: T) => void): (el: T | null) => void {
  const [el, setEl] = useState<T | null>(null);
  const handler = useRef(onWheel);
  handler.current = onWheel;
  useEffect(() => {
    if (!el) return;
    const listen = (e: Event) => {
      e.preventDefault();
      handler.current(e as WheelEvent, el);
    };
    el.addEventListener("wheel", listen, { passive: false });
    return () => el.removeEventListener("wheel", listen);
  }, [el]);
  return setEl;
}
