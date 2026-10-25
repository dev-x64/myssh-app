// The phone's Back button. Whatever is open on top (a menu, a dialog, a
// panel) says here how it closes; Back closes the last of them, and with
// nothing open it steps back through the app: from a terminal to the list,
// from a section to the hosts. With nowhere left to go the system puts the
// app behind, and its sessions go on.

import { useEffect, useRef } from "react";

const stack: { close: () => void }[] = [];

/** While `enabled`, Back calls `close` before anything opened earlier. */
export function useBack(close: () => void, enabled = true) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!enabled) return;
    const entry = { close: () => latest.current() };
    stack.push(entry);
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [enabled]);
}

/** What Back does after what is open on top: `true` when it did something. */
let fallback: () => boolean = () => false;

export function setBackFallback(handler: () => boolean) {
  fallback = handler;
}

/** Back was pressed: `false` leaves it to the system. */
export function goBack(): boolean {
  const top = stack[stack.length - 1];
  if (top) {
    top.close();
    return true;
  }
  return fallback();
}

// The Android activity asks the window this when Back is pressed.
(window as unknown as { __mysshBack: () => boolean }).__mysshBack = goBack;
