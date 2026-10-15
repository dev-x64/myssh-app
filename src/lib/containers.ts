// The names of containers the terminal has shown, so that one can be
// offered when a command that takes a container is being typed.
//
// They are read off the screen and its scrollback: from the tables that
// `docker ps` and its kin print, and from the lines `docker compose`
// reports with. Nothing is asked of the server and nothing is run on it.

import type { Terminal } from "@xterm/xterm";

/** How far back the terminal is read each time. */
const SCAN_LINES = 3000;
const MAX_NAMES = 400;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ID = /^[0-9a-f]{12}\s/;
/** Headings found only in tables of containers, beside the one for the names. */
const OTHER_HEADINGS = new Set(["CONTAINER ID", "IMAGE", "SERVICE", "CPU %", "STATUS"]);
const REPORTED =
  /^\s*\S?\s*Container (\S+)\s+(?:Creat|Start|Running|Recreat|Stopp|Remov|Healthy|Waiting|Restart|Kill|Exited|Error)/;

const PROGRAMS = new Set(["docker", "podman", "nerdctl"]);
/** Commands that take any number of containers. */
const SEVERAL = new Set(["stop", "start", "restart", "rm", "kill", "inspect", "pause", "unpause", "wait", "stats", "update"]);
/** Commands that take one container and then something else. */
const ONE = new Set(["logs", "exec", "attach", "top", "port", "rename", "commit", "export", "diff"]);

interface Table {
  /** Where the names' column begins and where the next one does. */
  from: number;
  to: number;
  /** Where the first columns begin: a row of the table has text exactly there. */
  starts: number[];
  ids: boolean;
}

/** The table a line is the heading of, if it is one. */
function heading(line: string): Table | null {
  if (!/^(?:CONTAINER ID|NAME)\s{2,}/.test(line)) return null;
  const columns = [...line.matchAll(/\S+(?: \S+)*/g)].map((match) => ({ text: match[0], at: match.index }));
  const names = columns.findIndex((column) => column.text === "NAMES" || column.text === "NAME");
  if (names < 0 || !columns.some((column) => OTHER_HEADINGS.has(column.text))) return null;
  return {
    from: columns[names].at,
    to: columns[names + 1]?.at ?? Infinity,
    starts: columns.slice(0, 3).map((column) => column.at),
    ids: columns[0].text === "CONTAINER ID",
  };
}

/** Whether a line is laid out as a row of a table: its first columns begin where the headings do. */
function isRow(line: string, table: Table): boolean {
  if (table.ids && !ID.test(line)) return false;
  return table.starts.every(
    (at) => line[at] !== undefined && line[at] !== " " && (at === 0 || line[at - 1] === " "),
  );
}

/**
 * The container names in lines of terminal output, in the order they
 * appear: those of one table together, a name reported on a line by itself.
 */
export function containerNames(lines: string[]): string[][] {
  const found: string[][] = [];
  let table: Table | null = null;
  for (const line of lines) {
    const head = heading(line);
    if (head) {
      table = head;
      found.push([]);
      continue;
    }
    if (table && isRow(line, table)) {
      for (const name of line.slice(table.from, table.to).trim().split(",")) {
        if (NAME.test(name)) found[found.length - 1].push(name);
      }
      continue;
    }
    table = null;
    const reported = REPORTED.exec(line)?.[1];
    if (reported && NAME.test(reported)) found.push([reported]);
  }
  return found;
}

/**
 * What is being typed where a container is expected: the part of its name
 * typed so far, or `null` when the command line is not at such a place.
 * `known` are names already seen; a command that takes one container
 * stops expecting it once one of them has been given.
 */
export function containerBeingTyped(input: string, known: Set<string>): string | null {
  const words = input.split(/\s+/);
  if (words[0] === "sudo") words.shift();
  if (!PROGRAMS.has(words[0] ?? "")) return null;
  if (words[1] === "container") words.splice(1, 1);
  const command = words[1] ?? "";
  if (words.length < 3 || (!SEVERAL.has(command) && !ONE.has(command))) return null;
  const typed = words[words.length - 1];
  if (typed.startsWith("-") || !/^[A-Za-z0-9_.-]*$/.test(typed)) return null;
  if (ONE.has(command) && words.slice(2, -1).some((word) => known.has(word))) return null;
  return typed;
}

export class Containers {
  /** Every name seen, in the reverse of the order they are offered in. */
  private seen = new Set<string>();

  constructor(private readonly term: Terminal) {}

  /** The names seen so far: what was shown latest first, a table's rows from the top. */
  names(): string[] {
    this.read();
    return [...this.seen].reverse();
  }

  private read() {
    const buffer = this.term.buffer.active;
    // Full-screen programs draw their own picture; it is not output to read.
    if (buffer.type !== "normal") return;
    const end = buffer.baseY + buffer.cursorY;
    const lines: string[] = [];
    for (let row = Math.max(0, end - SCAN_LINES); row <= end; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      // A row too long for the window is one line of output on several of the screen.
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += line.translateToString(false);
      else lines.push(line.translateToString(false));
    }
    for (const together of containerNames(lines.map((line) => line.trimEnd()))) {
      for (const name of together.reverse()) {
        this.seen.delete(name);
        this.seen.add(name);
      }
    }
    while (this.seen.size > MAX_NAMES) this.seen.delete(this.seen.values().next().value!);
  }
}
