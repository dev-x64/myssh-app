// The keys a phone's keyboard lacks, in two rows above it: Esc, Tab, Ctrl
// and Alt, the arrows, and the characters a shell wants most. A key acts
// as the finger comes down, and does not take the focus, so the keyboard
// stays up; an arrow held down repeats.

import { readText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Keyboard,
  KeyboardOff,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { getSession } from "../../lib/sessions";
import { useUi, type Tab } from "../../lib/store";
import { useModifiers } from "../../lib/touchKeys";
import { cx } from "../ui";

type Key =
  /** A key the terminal turns into what the program expects. */
  | { kind: "key"; key: string; label?: string; icon?: LucideIcon; repeat?: boolean }
  /** Characters, typed. */
  | { kind: "text"; text: string }
  | { kind: "mod"; mod: "ctrl" | "alt"; label: string }
  | { kind: "paste" }
  | { kind: "keyboard" };

const ROWS: Key[][] = [
  [
    { kind: "key", key: "Escape", label: "ESC" },
    { kind: "text", text: "/" },
    { kind: "text", text: "|" },
    { kind: "text", text: "-" },
    { kind: "text", text: "~" },
    { kind: "key", key: "Home", label: "HOME" },
    { kind: "key", key: "ArrowUp", icon: ArrowUp, repeat: true },
    { kind: "key", key: "End", label: "END" },
  ],
  [
    { kind: "key", key: "Tab", label: "TAB" },
    { kind: "mod", mod: "ctrl", label: "CTRL" },
    { kind: "mod", mod: "alt", label: "ALT" },
    { kind: "paste" },
    { kind: "keyboard" },
    { kind: "key", key: "ArrowLeft", icon: ArrowLeft, repeat: true },
    { kind: "key", key: "ArrowDown", icon: ArrowDown, repeat: true },
    { kind: "key", key: "ArrowRight", icon: ArrowRight, repeat: true },
  ],
];

/** Held down this long, a repeating key starts repeating, this often. */
const REPEAT_AFTER_MS = 380;
const REPEAT_EVERY_MS = 55;

/**
 * Whether the phone's keyboard is up. The window is made shorter for it,
 * so it is up while the window is well short of the tallest it has been
 * (in this orientation). The terminal keeps the focus when the keyboard is
 * put away with Back, so the focus does not say.
 */
function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const tallest = new Map<string, number>();
    const update = () => {
      const turn = screen.orientation?.type ?? "";
      const most = Math.max(tallest.get(turn) ?? 0, window.innerHeight);
      tallest.set(turn, most);
      setUp(window.innerHeight < most * 0.8);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return up;
}

export function ExtraKeys({ tab }: { tab: Tab }) {
  const t = useT();
  const ctrl = useModifiers((s) => s.ctrl);
  const alt = useModifiers((s) => s.alt);
  const typing = useKeyboardUp();
  const timer = useRef<number | undefined>(undefined);
  const [down, setDown] = useState<string | null>(null);

  // Let go of a repeating key wherever the finger goes.
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const stop = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setDown(null);
  };

  // Over files, the editor or a dialog there is no terminal to type into.
  if (tab.status !== "connected" || tab.files || tab.editor || tab.prompt) return null;
  const session = getSession(tab.id);
  if (!session) return null;

  const act = (key: Key) => {
    switch (key.kind) {
      case "key":
        session.press(key.key);
        break;
      case "text":
        session.typeText(key.text);
        break;
      case "mod":
        useModifiers.getState().toggle(key.mod);
        break;
      case "paste":
        void readText()
          .then((text) => {
            if (text) session.insert(text);
            else useUi.getState().toast("info", t("mobile.paste.empty"));
          })
          .catch(() => useUi.getState().toast("info", t("mobile.paste.empty")));
        break;
      case "keyboard":
        // Focused again, the terminal brings the keyboard back up.
        session.term.blur();
        if (!typing) session.focus();
        break;
    }
  };

  const onDown = (e: PointerEvent, key: Key, id: string) => {
    // The terminal keeps the focus, and with it the keyboard.
    e.preventDefault();
    setDown(id);
    navigator.vibrate?.(8);
    act(key);
    if (key.kind === "key" && key.repeat) {
      const again = () => {
        act(key);
        timer.current = window.setTimeout(again, REPEAT_EVERY_MS);
      };
      timer.current = window.setTimeout(again, REPEAT_AFTER_MS);
    }
  };

  return (
    <div className="m-keys" role="toolbar" aria-label={t("mobile.term.keyboard")}>
      {ROWS.map((row, r) => (
        <div key={r} className="m-keys-row">
          {row.map((key, c) => {
            const id = `${r}:${c}`;
            const on = key.kind === "mod" && (key.mod === "ctrl" ? ctrl : alt);
            let content: ReactNode;
            let label: string;
            if (key.kind === "key") {
              const Icon = key.icon;
              content = Icon ? <Icon size={17} /> : key.label;
              label = key.label ?? key.key;
            } else if (key.kind === "text") {
              content = key.text;
              label = key.text;
            } else if (key.kind === "mod") {
              content = key.label;
              label = key.label;
            } else if (key.kind === "paste") {
              content = <ClipboardPaste size={17} />;
              label = t("mobile.term.paste");
            } else {
              content = typing ? <KeyboardOff size={17} /> : <Keyboard size={17} />;
              label = t("mobile.term.keyboard");
            }
            return (
              <button
                key={id}
                type="button"
                tabIndex={-1}
                aria-label={label}
                aria-pressed={key.kind === "mod" ? on : undefined}
                className={cx("m-key", key.kind === "text" && "char", on && "on", down === id && "down")}
                onPointerDown={(e) => onDown(e, key, id)}
                onPointerUp={stop}
                onPointerCancel={stop}
                onPointerLeave={stop}
                onMouseDown={(e) => e.preventDefault()}
                onContextMenu={(e) => e.preventDefault()}
              >
                {content}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
