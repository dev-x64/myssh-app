import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

/** Colours for the people of a shared session; the host is `0`. */
const TONES = ["var(--accent)", "#4c8dff", "#3ecf8e", "#f472b6", "#f5b83d", "#8b7cf6", "#22c3c3", "#f2666b", "#a7b0c0"];

export function personTone(id: number): string {
  return TONES[id % TONES.length];
}

/** The tag's height; it has to be known to place the tag above the cursor. */
const TAG_HEIGHT = 15;

/**
 * A small name tag attached to the terminal's cursor, saying who has the
 * keyboard in a shared session: it sits on top of the cursor like a flag,
 * its left edge on the cursor's, so that it is plain whose typing this is.
 * It is placed in the nearest positioned ancestor of the terminal.
 */
export function CursorBadge(props: { term: Terminal; name: string; tone: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const { term } = props;

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const parent = ref.current?.offsetParent;
      const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
      const buffer = term.buffer.active;
      // Scrolled back, the cursor is not on screen.
      if (!parent || !screen || buffer.viewportY !== buffer.baseY) {
        setPlace(null);
        return;
      }
      const outer = parent.getBoundingClientRect();
      const inner = screen.getBoundingClientRect();
      if (inner.width === 0) return;
      const cellWidth = inner.width / term.cols;
      const cellHeight = inner.height / term.rows;
      const left = inner.left - outer.left + buffer.cursorX * cellWidth;
      const above = inner.top - outer.top + buffer.cursorY * cellHeight - TAG_HEIGHT;
      // On the first row there is no room above: the tag hangs below instead.
      const below = above < 0;
      const next = {
        left: Math.round(Math.max(0, Math.min(left, outer.width - 24))),
        top: Math.round(below ? above + TAG_HEIGHT + cellHeight : above),
        below,
      };
      setPlace((old) =>
        old && old.left === next.left && old.top === next.top && old.below === next.below ? old : next,
      );
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(measure);
    };
    const subscriptions = [
      term.onRender(schedule),
      term.onCursorMove(schedule),
      term.onScroll(schedule),
      term.onResize(schedule),
    ];
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [term]);

  // Short enough to stay a tag: the first word, or the part before "@".
  const label = (props.name.split(/[@\s]/)[0] || "?").slice(0, 14);
  return (
    <span
      ref={ref}
      className={place?.below ? "cursor-badge below" : "cursor-badge"}
      title={props.name}
      style={{
        background: props.tone,
        ...(place ? { left: place.left, top: place.top } : { visibility: "hidden" }),
      }}
    >
      {label}
    </span>
  );
}
