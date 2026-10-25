// The keys a phone's keyboard lacks (Esc, Tab, Ctrl, Alt, the arrows), as
// a bar above it. Ctrl and Alt there are held for the next key, whichever
// keyboard it comes from: Ctrl, then C on the phone's keyboard, is Ctrl+C.

import { create } from "zustand";

interface Modifiers {
  ctrl: boolean;
  alt: boolean;
  toggle: (which: "ctrl" | "alt") => void;
  clear: () => void;
}

export const useModifiers = create<Modifiers>((set) => ({
  ctrl: false,
  alt: false,
  toggle: (which) => set((s) => ({ [which]: !s[which] }) as Partial<Modifiers>),
  clear: () => set({ ctrl: false, alt: false }),
}));

/** What Ctrl makes of a character, as a terminal sends it; `null` if nothing. */
function control(char: string): string | null {
  if (char.length !== 1) return null;
  const code = char.toUpperCase().charCodeAt(0);
  // @ A–Z [ \ ] ^ _ are 0 to 31; Ctrl+Space is NUL and Ctrl+? is DEL.
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  if (char === " ") return "\x00";
  if (char === "?") return "\x7f";
  if (char === "/") return "\x1f";
  return null;
}

/**
 * What was typed, with Ctrl or Alt from the bar applied to it, which they
 * then let go of. Only a single character takes them: a word the keyboard
 * puts in at once goes as it is.
 */
export function withModifiers(data: string): string {
  const { ctrl, alt, clear } = useModifiers.getState();
  if (!ctrl && !alt) return data;
  if ([...data].length !== 1) return data;
  clear();
  let out = data;
  if (ctrl) out = control(data) ?? data;
  if (alt) out = `\x1b${out}`;
  return out;
}

const KEY_CODES: Record<string, number> = {
  Escape: 27,
  Tab: 9,
  Enter: 13,
  Backspace: 8,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

/**
 * Presses a key on the terminal's input as the keyboard would: the
 * terminal turns it into what the program expects (arrows differ in some
 * modes), and the suggestions and password list hear it first, as they
 * hear a real key.
 */
export function pressKey(target: HTMLElement, key: string) {
  const { ctrl, alt, clear } = useModifiers.getState();
  clear();
  const event = new KeyboardEvent("keydown", {
    key,
    code: key,
    ctrlKey: ctrl,
    altKey: alt,
    bubbles: true,
    cancelable: true,
  });
  // The terminal reads the old key codes, which a made-up event lacks.
  const keyCode = KEY_CODES[key] ?? 0;
  Object.defineProperty(event, "keyCode", { get: () => keyCode });
  Object.defineProperty(event, "which", { get: () => keyCode });
  target.dispatchEvent(event);
}
