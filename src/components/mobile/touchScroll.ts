// A finger drawn up or down a terminal scrolls it, and a flick carries on
// for a while, as a phone's pages do. It does what a mouse wheel does
// there: scrolls back through the output, or, in a full-screen program
// (less, vim, htop, man), moves through it with the arrow keys.

import { useEffect, type RefObject } from "react";
import { getSession } from "../../lib/sessions";

/** A finger moving less than this is a tap, which the terminal keeps. */
const SLOP = 8;
/** How much of a flick's speed is left after each frame. */
const FRICTION = 0.94;

/** `tabId`: the terminal shown, which the finger scrolls; `null` for none. */
export function useTouchScroll(ref: RefObject<HTMLElement | null>, tabId: string | null) {
  useEffect(() => {
    const element = ref.current;
    const session = tabId ? getSession(tabId) : undefined;
    if (!element || !session) return;
    const term = session.term;
    let target: Element | null = null;
    /** Pixels moved that have not yet made a whole line. */
    let rest = 0;
    let startY = 0;
    let lastY = 0;
    let lastAt = 0;
    let speed = 0;
    let scrolling = false;
    let frame = 0;

    const wheel = (deltaY: number) => {
      const screen = term.element?.querySelector(".xterm-screen");
      if (!screen) return;
      const cell = screen.getBoundingClientRect().height / term.rows;
      rest += deltaY;
      const lines = Math.trunc(rest / cell);
      if (lines === 0) return;
      rest -= lines * cell;
      if (term.buffer.active.type === "alternate") {
        // Up the screen is back in the text: the arrow up, as a wheel would.
        const key = lines < 0 ? "ArrowUp" : "ArrowDown";
        for (let i = 0; i < Math.min(Math.abs(lines), 5); i++) session.press(key);
      } else {
        term.scrollLines(lines);
      }
    };

    const onStart = (e: TouchEvent) => {
      cancelAnimationFrame(frame);
      if (e.touches.length !== 1) {
        target = null;
        return;
      }
      // Anywhere on the terminal's area, which is larger than its grid of cells.
      const area = term.element?.closest(".term-host") ?? null;
      target = area?.contains(e.target as Node) ? area : null;
      rest = 0;
      startY = lastY = e.touches[0].clientY;
      lastAt = e.timeStamp;
      speed = 0;
      scrolling = false;
    };

    const onMove = (e: TouchEvent) => {
      if (!target || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      if (!scrolling && Math.abs(y - startY) < SLOP) return;
      scrolling = true;
      // The page must not move, and the terminal must not take it for a click.
      e.preventDefault();
      const dy = lastY - y;
      const dt = Math.max(1, e.timeStamp - lastAt);
      speed = 0.8 * (dy / dt) + 0.2 * speed;
      lastY = y;
      lastAt = e.timeStamp;
      wheel(dy);
    };

    const onEnd = () => {
      if (!scrolling || !target) return;
      scrolling = false;
      // Pixels a frame, from pixels a millisecond.
      let velocity = speed * 16;
      const glide = () => {
        if (Math.abs(velocity) < 0.6) return;
        wheel(velocity);
        velocity *= FRICTION;
        frame = requestAnimationFrame(glide);
      };
      frame = requestAnimationFrame(glide);
    };

    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd, { passive: true });
    element.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onEnd);
    };
  }, [ref, tabId]);
}
