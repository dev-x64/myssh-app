// Colouring of what is worth noticing in terminal output: addresses, words
// that say something went wrong or right, links.
//
// The output itself is never changed. Matches are found in the lines that
// are on screen and coloured with decorations, which follow their line as
// it scrolls and go away with it.

import type { IBufferLine, IDecoration, IMarker, Terminal } from "@xterm/xterm";

export interface HighlightRules {
  ip: boolean;
  status: boolean;
  urls: boolean;
}

export interface HighlightColors {
  ip: string;
  error: string;
  warning: string;
  success: string;
  url: string;
}

export interface Span {
  /** Offsets into the line's text; `end` is exclusive. */
  start: number;
  end: number;
  color: string;
}

const URL = /https?:\/\/[^\s"'<>`]+/g;
/** Four numbers of 0-255, optionally with a prefix length; not part of a longer dotted run. */
const IPV4 =
  /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\/(?:3[0-2]|[12]?\d))?(?![\w]|\.\d)/g;
/** Anything shaped like an IPv6 address; `isIpv6` then decides. */
const IPV6_LIKE = /(?<![\w:.])[0-9a-fA-F:]*:[0-9a-fA-F:]*(?:\/(?:12[0-8]|1[01]\d|[1-9]?\d))?(?![\w:])/g;
const ERROR =
  /\b(?:errors?|failed|failure|fatal|denied|refused|critical|panic|exception|traceback|segfault|unreachable)\b/gi;
const WARNING = /\b(?:warn|warnings?|deprecated)\b/gi;
const SUCCESS = /\b(?:success|successful|successfully|succeeded|passed)\b|\bactive \(running\)/gi;

/** A clock time or a MAC address has colons too; an address has its own shape. */
export function isIpv6(text: string): boolean {
  const address = text.split("/")[0];
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half === "" ? [] : half.split(":")));
  if (groups.length === 0 || groups.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) return false;
  // Written in full it has eight groups; "::" stands for the ones left out.
  return halves.length === 2 ? groups.length <= 7 : groups.length === 8;
}

/** What to colour in a line of text. Spans never overlap; a link wins over what is inside it. */
export function findSpans(text: string, rules: HighlightRules, colors: HighlightColors): Span[] {
  const spans: Span[] = [];
  const add = (pattern: RegExp, color: string, accept?: (match: string) => boolean, trim?: RegExp) => {
    pattern.lastIndex = 0;
    for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
      if (found[0] === "") {
        pattern.lastIndex += 1;
        continue;
      }
      const match = trim ? found[0].replace(trim, "") : found[0];
      const start = found.index;
      const end = start + match.length;
      if (match === "" || (accept && !accept(match))) continue;
      if (spans.some((span) => start < span.end && end > span.start)) continue;
      spans.push({ start, end, color });
    }
  };
  // A sentence's own punctuation is not part of the link before it.
  if (rules.urls) add(URL, colors.url, undefined, /[.,;:!?)\]}]+$/);
  if (rules.ip) {
    add(IPV4, colors.ip);
    add(IPV6_LIKE, colors.ip, isIpv6);
  }
  if (rules.status) {
    add(ERROR, colors.error);
    add(WARNING, colors.warning);
    add(SUCCESS, colors.success);
  }
  return spans.sort((a, b) => a.start - b.start);
}

interface Line {
  marker: IMarker;
  text: string;
  decorations: IDecoration[];
}

/** The text of a screen line, and for every character the column it starts in. */
function read(line: IBufferLine, cols: number): { text: string; columns: number[]; widths: number[] } {
  let text = "";
  const columns: number[] = [];
  const widths: number[] = [];
  let cell = line.getCell(0);
  for (let x = 0; x < cols; x++) {
    cell = line.getCell(x, cell);
    if (!cell) break;
    const width = cell.getWidth();
    // The second half of a wide character has no text of its own.
    if (width === 0) continue;
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) {
      columns.push(x);
      widths.push(width);
    }
    text += chars;
  }
  return { text, columns, widths };
}

export class Highlighter {
  private lines: Line[] = [];
  private rules: HighlightRules = { ip: false, status: false, urls: false };
  private colors: HighlightColors | null = null;
  private readonly listener: { dispose(): void };

  constructor(private readonly term: Terminal) {
    // Whatever is drawn is looked at; nothing else needs colouring.
    this.listener = term.onRender(({ start, end }) => this.scan(start, end));
  }

  /** Sets what is coloured and with what; everything on screen is redone. */
  configure(rules: HighlightRules, colors: HighlightColors) {
    const same =
      this.colors !== null &&
      (Object.keys(rules) as (keyof HighlightRules)[]).every((key) => rules[key] === this.rules[key]) &&
      (Object.keys(colors) as (keyof HighlightColors)[]).every((key) => colors[key] === this.colors?.[key]);
    if (same) return;
    this.rules = { ...rules };
    this.colors = { ...colors };
    this.clear();
    this.scan(0, this.term.rows - 1);
  }

  private get active(): boolean {
    return this.rules.ip || this.rules.status || this.rules.urls;
  }

  private drop(line: Line) {
    for (const decoration of line.decorations) decoration.dispose();
    line.marker.dispose();
  }

  private clear() {
    for (const line of this.lines) this.drop(line);
    this.lines = [];
  }

  private scan(start: number, end: number) {
    const buffer = this.term.buffer.active;
    // Full-screen programs draw their own picture; it is left alone.
    if (!this.active || !this.colors || buffer.type !== "normal") {
      if (this.lines.length > 0) this.clear();
      return;
    }
    const top = buffer.viewportY;
    const known = new Map<number, Line>();
    this.lines = this.lines.filter((line) => {
      if (line.marker.isDisposed || line.marker.line < 0) {
        this.drop(line);
        return false;
      }
      known.set(line.marker.line, line);
      return true;
    });

    for (let row = start; row <= end; row++) {
      const y = top + row;
      const bufferLine = buffer.getLine(y);
      if (!bufferLine) continue;
      const { text, columns, widths } = read(bufferLine, this.term.cols);
      const existing = known.get(y);
      if (existing?.text === text) continue;
      if (existing) {
        this.drop(existing);
        this.lines = this.lines.filter((line) => line !== existing);
      }
      const spans = text.trim() === "" ? [] : findSpans(text, this.rules, this.colors);
      if (spans.length === 0) continue;
      const marker = this.term.registerMarker(y - (buffer.baseY + buffer.cursorY));
      if (!marker) continue;
      const decorations: IDecoration[] = [];
      for (const span of spans) {
        const x = columns[span.start];
        const last = span.end - 1;
        const decoration = this.term.registerDecoration({
          marker,
          x,
          width: columns[last] + widths[last] - x,
          foregroundColor: span.color,
        });
        if (decoration) decorations.push(decoration);
      }
      this.lines.push({ marker, text, decorations });
    }

    // Lines far from what is shown are coloured again when they come back.
    const from = top - this.term.rows;
    const to = top + 2 * this.term.rows;
    this.lines = this.lines.filter((line) => {
      if (line.marker.line >= from && line.marker.line <= to) return true;
      this.drop(line);
      return false;
    });
  }

  dispose() {
    this.listener.dispose();
    this.clear();
  }
}
