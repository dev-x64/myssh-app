// Dragging inside the window, and files dragged in from the system.
//
// The window takes files dropped from Finder or Explorer itself, to know
// where they are on disk; while it does, the browser's own drag and drop
// does not work inside it. So things are dragged here with the mouse:
// a press, a move of a few pixels, and the drag is on until the button is
// let go. Whatever can take a drop says so with `dropTarget`, and both kinds
// of drag end on the innermost such element under the pointer that takes it.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { create } from "zustand";
import { MOBILE, WINDOWS } from "./platform";

/** Something dragged: `files` are paths on this computer, dragged in from the system. */
export interface Payload {
  kind: string;
  data?: unknown;
  /** For `files`. */
  paths?: string[];
}

export interface Target {
  /** Tells the target apart from the others, for `useDrag((s) => s.over)`. */
  key: string;
  accepts: (payload: Payload) => boolean;
  drop: (payload: Payload) => void;
}

interface DragState {
  /** What is being dragged, once the drag is on. */
  payload: Payload | null;
  /** The key of the target under the pointer that would take it. */
  over: string | null;
}

export const useDrag = create<DragState>(() => ({ payload: null, over: null }));

const targets = new WeakMap<Element, Target>();

/**
 * A callback ref that makes an element take drops. Called on every render
 * with the target as it is now, so its handlers are never stale.
 */
export function dropTarget(target: Target) {
  return (element: HTMLElement | null) => {
    if (element) targets.set(element, target);
  };
}

/** The innermost target at a point of the window that takes the payload. */
function targetAt(x: number, y: number, payload: Payload): Target | null {
  let element: Element | null = document.elementFromPoint(x, y);
  while (element) {
    const target = targets.get(element);
    if (target?.accepts(payload)) return target;
    element = element.parentElement;
  }
  return null;
}

/** How far the pointer moves before a press becomes a drag. */
const THRESHOLD = 5;

export interface DragOptions {
  /** Shown by the pointer while dragging; nothing is shown without it. */
  label?: string;
  /** The drag has begun: the pointer has moved far enough. */
  onStart?: () => void;
  /** Each move of the pointer while dragging. */
  onMove?: (x: number, y: number) => void;
  /** The drag is over, dropped or not. */
  onEnd?: (dropped: boolean) => void;
}

/**
 * Begins what may become a drag, from a press of the left button. Nothing
 * of the press is taken away: a click without moving stays a click.
 */
export function startDrag(
  e: { button: number; clientX: number; clientY: number },
  payload: Payload,
  options: DragOptions = {},
) {
  if (MOBILE || e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let started = false;
  let ghost: HTMLDivElement | null = null;

  const begin = () => {
    started = true;
    window.getSelection()?.removeAllRanges();
    document.documentElement.classList.add("dragging");
    if (options.label) {
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = options.label;
      document.body.appendChild(ghost);
    }
    useDrag.setState({ payload, over: null });
    options.onStart?.();
  };

  const move = (moved: MouseEvent) => {
    if (!started) {
      if (Math.hypot(moved.clientX - startX, moved.clientY - startY) < THRESHOLD) return;
      begin();
    }
    moved.preventDefault();
    if (ghost) ghost.style.transform = `translate(${moved.clientX + 12}px, ${moved.clientY + 10}px)`;
    const over = targetAt(moved.clientX, moved.clientY, payload)?.key ?? null;
    if (useDrag.getState().over !== over) useDrag.setState({ over });
    options.onMove?.(moved.clientX, moved.clientY);
  };

  const finish = (dropAt: { x: number; y: number } | null) => {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", up, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    if (!started) return;
    ghost?.remove();
    document.documentElement.classList.remove("dragging");
    useDrag.setState({ payload: null, over: null });
    // The click that follows letting go is not a click on what is under it.
    const swallow = (click: MouseEvent) => {
      click.stopPropagation();
      click.preventDefault();
    };
    window.addEventListener("click", swallow, true);
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    const target = dropAt ? targetAt(dropAt.x, dropAt.y, payload) : null;
    target?.drop(payload);
    options.onEnd?.(target !== null);
  };
  const up = (released: MouseEvent) => finish({ x: released.clientX, y: released.clientY });
  const cancel = () => finish(null);
  const key = (pressed: KeyboardEvent) => {
    if (pressed.key !== "Escape" || !started) return;
    pressed.preventDefault();
    pressed.stopPropagation();
    cancel();
  };

  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", up, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}

/**
 * Files dragged in from the system: the target under them lights up, and
 * takes them when they are dropped. The position comes in pixels of the
 * screen on Windows, and in the page's own elsewhere.
 */
export function startFileDrops() {
  if (MOBILE) return;
  let paths: string[] = [];
  const at = (position: { x: number; y: number }) => {
    const scale = WINDOWS ? window.devicePixelRatio || 1 : 1;
    return { x: position.x / scale, y: position.y / scale };
  };
  void getCurrentWebview()
    .onDragDropEvent(({ payload: event }) => {
      if (event.type === "enter") {
        paths = event.paths;
        if (paths.length === 0) return;
        useDrag.setState({ payload: { kind: "files", paths }, over: null });
      }
      if (paths.length === 0) return;
      const payload: Payload = { kind: "files", paths };
      if (event.type === "enter" || event.type === "over") {
        const { x, y } = at(event.position);
        const over = targetAt(x, y, payload)?.key ?? null;
        if (useDrag.getState().over !== over) useDrag.setState({ over });
      } else if (event.type === "drop") {
        const { x, y } = at(event.position);
        useDrag.setState({ payload: null, over: null });
        targetAt(x, y, { kind: "files", paths: event.paths })?.drop({ kind: "files", paths: event.paths });
        paths = [];
      } else {
        useDrag.setState({ payload: null, over: null });
        paths = [];
      }
    })
    .catch(() => {});
}
