// The app's own shortcuts as they are pressed on this system: as the Mac's
// menu bar has them, or with Ctrl and Shift where there is none (Ctrl with
// a letter alone belongs to the shell; see SHORTCUTS in App.tsx).

import { MAC } from "./platform";

const KEYS = {
  new_host: ["⌘N", "Ctrl+Shift+N"],
  new_tab: ["⌘T", "Ctrl+Shift+T"],
  files: ["⌘⇧F", "Ctrl+Shift+E"],
  snippets: ["⌘⇧S", "Ctrl+Shift+S"],
  find: ["⌘F", "Ctrl+Shift+F"],
} as const;

export function keyOf(action: keyof typeof KEYS): string {
  return KEYS[action][MAC ? 0 : 1];
}
