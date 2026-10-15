// Suggestions from the list of well-known commands: what could follow the
// text typed so far, and what it may have been meant to be when a word is
// misspelt.

import { COMMANDS, OTHER_NAMES, OTHER_SUBCOMMANDS, type KnownCommand } from "./commands";
import { SUBCOMMANDS } from "./subcommands";

/** A word that can be told apart from a misspelling: a name, not a flag or a path. */
const NAME = /^[a-z][a-z0-9_.-]*$/;
/** What may be a slip of a name: letters, perhaps with a stray leading dash. */
const TYPED = /^-?[a-zA-Z][a-zA-Z0-9_.-]*$/;

/** For each run of words, the words known to follow it. `""` is the start. */
const NEXT = new Map<string, Set<string>>();

function learn(path: string, word: string) {
  const known = NEXT.get(path);
  if (known) known.add(word);
  else NEXT.set(path, new Set([word]));
}

for (const { command } of COMMANDS) {
  const words = command.trim().split(/\s+/);
  let path = "";
  for (const word of words) {
    // Past a pipe or an `&&` another command begins.
    if (word === "|" || word === "&&" || word === ";") break;
    learn(path, word);
    path = path ? `${path} ${word}` : word;
  }
}
for (const name of OTHER_NAMES) learn("", name);
for (const [path, words] of Object.entries(OTHER_SUBCOMMANDS)) {
  for (const word of words) learn(path, word);
}
for (const [path, subs] of Object.entries(SUBCOMMANDS)) {
  for (const { name } of subs) learn(path, name);
}

/** Edits between two words, counting a swap of neighbours as one. */
export function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * The known word a typed one was most likely meant to be, if exactly one
 * is close enough. `partial`: the word is still being typed, so it is also
 * compared with the beginnings of longer words.
 */
function meant(typed: string, known: Set<string>, partial: boolean): string | null {
  if (!TYPED.test(typed) || typed.replace(/^-/, "").length < 2) return null;
  const word = typed.toLowerCase();
  const limit = word.length >= 7 ? 2 : 1;
  let best: string | null = null;
  let bestScore = limit + 1;
  let tie = false;
  for (const candidate of known) {
    if (!NAME.test(candidate) || candidate.length < 2) continue;
    // Two-letter words are too easily mistaken for one another, except by a swap.
    if (word.length === 2 && !(candidate.length === 2 && candidate[0] === word[1] && candidate[1] === word[0])) {
      continue;
    }
    let score = distance(word, candidate);
    if (partial && word.length >= 4 && candidate.length > word.length) {
      score = Math.min(score, distance(word, candidate.slice(0, word.length)));
    }
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && candidate !== best) {
      tie = true;
    }
  }
  return best !== null && bestScore <= limit && !tie ? best : null;
}

/** `sudo ` in front of a command is set aside and put back. */
function splitSudo(input: string): [string, string] {
  const match = /^(sudo\s+)(.*)$/s.exec(input);
  return match ? [match[1], match[2]] : ["", input];
}

/** Known commands that continue what has been typed, commonest first. */
export function knownCommands(input: string, limit: number): { entry: KnownCommand; label: string }[] {
  const [sudo, rest] = splitSudo(input);
  if (rest.trim().length < 2) return [];
  return COMMANDS.filter((entry) => entry.command.length > rest.length && entry.command.startsWith(rest))
    .slice(0, limit)
    .map((entry) => ({ entry, label: `${sudo}${entry.command}` }));
}

export interface Fix {
  /** The line as it was probably meant, the rest of it untouched. */
  line: string;
  /** Known commands that continue the corrected line. */
  completions: { entry: KnownCommand; label: string }[];
}

/**
 * What the line was probably meant to be, when a command or subcommand in
 * it is misspelt. `null` when nothing looks wrong.
 *
 * `trustFirstWord`: the command name has been run before, so it is taken
 * as it is however unfamiliar.
 */
export function findFix(input: string, trustFirstWord: boolean): Fix | null {
  const [sudo, rest] = splitSudo(input);
  const words = rest.split(/\s+/);
  // An empty last piece means the line ends with a space: every word is complete.
  const partialLast = words[words.length - 1] !== "";
  if (!partialLast) words.pop();
  if (words.length === 0) return null;

  const corrected: string[] = [];
  let path = "";
  let changed = false;
  let index = 0;
  for (; index < words.length; index++) {
    const word = words[index];
    const known = NEXT.get(path);
    if (!known) break;
    const partial = partialLast && index === words.length - 1;
    const fits = known.has(word) || (partial && [...known].some((k) => k.startsWith(word)));
    let next = word;
    if (!fits) {
      if (index === 0 && trustFirstWord) return null;
      const guess = meant(word, known, partial);
      // An unknown command is left alone; an unknown argument ends the walk.
      if (!guess) {
        if (index === 0) return null;
        break;
      }
      next = guess;
      changed = true;
    }
    corrected.push(next);
    path = path ? `${path} ${next}` : next;
  }
  if (!changed) return null;

  const tail = words.slice(index);
  const fixedCommand = [...corrected, ...tail].join(" ");
  const line = `${sudo}${fixedCommand}${partialLast ? "" : " "}`;
  // Only a line that was understood to its end can be continued.
  const completions =
    tail.length === 0
      ? COMMANDS.filter(
          (entry) => entry.command.startsWith(fixedCommand) && entry.command.trim() !== fixedCommand,
        )
          .slice(0, 2)
          .map((entry) => ({ entry, label: `${sudo}${entry.command}` }))
      : [];
  return { line, completions };
}
