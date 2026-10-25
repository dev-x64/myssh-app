// Two fingers pinched on a terminal make its text smaller or larger, as a
// phone's own pages do. The size is the one in Settings, for every terminal.

import { useEffect, type RefObject } from "react";
import { t } from "../../lib/i18n";
import { useSettings } from "../../lib/settings";
import { useUi } from "../../lib/store";

/** How far apart the fingers go, as a share, for each step of the size. */
const STEP = 0.12;

function spread(touches: TouchList): number {
  const [a, b] = [touches[0], touches[1]];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export function usePinchZoom(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    let start = 0;
    let steps = 0;
    let shown = 0;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      start = spread(e.touches);
      steps = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !start) return;
      // The page itself must not zoom, nor the terminal scroll, meanwhile.
      e.preventDefault();
      const now = Math.round(Math.log(spread(e.touches) / start) / Math.log(1 + STEP));
      if (now === steps) return;
      useSettings.getState().bumpFontSize(now > steps ? 1 : -1);
      steps += now > steps ? 1 : -1;
      // The new size is said once the fingers rest, not at every step.
      window.clearTimeout(shown);
      shown = window.setTimeout(() => {
        useUi.getState().toast("info", t("mobile.term.font", { n: useSettings.getState().fontSize }));
      }, 450);
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) start = 0;
    };
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd, { passive: true });
    element.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.clearTimeout(shown);
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onEnd);
    };
  }, [ref, enabled]);
}
