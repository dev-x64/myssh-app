// A look over a snippet's script while it is written, here and at once:
// what a command name was probably meant to be, what could do harm, what
// will stop and wait for an answer, and line endings from Windows. The
// syntax itself is bash's to judge (`api.scriptCheck`, which runs `bash -n`).
// Nothing here is sent anywhere.

import { translate, type Locale, type MessageKey } from "./i18n";
import { findFix } from "./typos";

export interface ScriptIssue {
  level: "error" | "warn" | "info";
  /** 1-based; `null` for the script as a whole. */
  line: number | null;
  text: string;
  /** The script as it would be with the issue fixed, when there is one fix. */
  fix?: string;
}

/** What can do harm, said in a few words. */
const DANGERS: [RegExp, MessageKey][] = [
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*\s+(-[a-zA-Z]*\s+)*(\/|\/\*|~\/?|\$HOME\/?)(\s|;|$)/, "lint.rm_root"],
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*\s+(-[a-zA-Z]*\s+)*"?\$\{?\w+\}?"?\/\S*/, "lint.rm_var"],
  [/\bmkfs(\.\w+)?\b/, "lint.mkfs"],
  [/\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|vd|xvd|mmcblk|disk)/, "lint.dd"],
  [/>\s*\/dev\/(sd|nvme|hd|vd|xvd|mmcblk)\w*/, "lint.dd"],
  [/\bchmod\s+(-[a-zA-Z]*\s+)*-R\s+(0?777|a\+rwx)\s+\/(\s|$)/, "lint.chmod_root"],
  [/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, "lint.pipe_sh"],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "lint.fork_bomb"],
  [/\b(shutdown|reboot|poweroff|halt)\b/, "lint.reboot"],
  [/\biptables\s+(-[a-zA-Z]+\s+)*-F\b|\bufw\s+(--force\s+)?(reset|disable)\b|\bnft\s+flush\s+ruleset\b/, "lint.firewall"],
];

/** Package managers asking "Do you want to continue? [Y/n]" unless told yes. */
const ASKS_YES = /\b(apt|apt-get|yum|dnf|zypper)\s+(install|remove|purge|upgrade|dist-upgrade|full-upgrade|autoremove|update)\b/;
const SAID_YES = /\s(-y|--yes|--assume-yes|-q\s*-y|--non-interactive)\b/;

/**
 * The commands of a line, split where one ends and the next begins
 * (`;`, `&&`, `||`, `|`), leaving what is inside quotes alone. Each with
 * where it starts in the line.
 */
function commands(line: string): { text: string; at: number }[] {
  const found: { text: string; at: number }[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') i++;
      continue;
    }
    if (c === "\\") {
      i++;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      break;
    } else if (c === ";" || c === "|" || c === "&") {
      found.push({ text: line.slice(start, i), at: start });
      if (line[i + 1] === c) i++;
      start = i + 1;
    }
  }
  found.push({ text: line.slice(start, quote ? start : line.length), at: start });
  return found.filter((command) => command.text.trim() !== "");
}

/** Words before the command itself that do not change which command it is. */
const LEADING = /^(\s*(sudo(\s+-[a-zA-Z]+)*|time|nohup|exec|nice|env|\w+=\S*)\s+)*/;

export function lintScript(script: string, locale: Locale): ScriptIssue[] {
  const t = (key: MessageKey, vars?: Record<string, string>) => translate(locale, key, vars);
  const issues: ScriptIssue[] = [];
  if (script.includes("\r")) {
    issues.push({ level: "info", line: null, text: t("lint.crlf"), fix: script.replace(/\r/g, "") });
  }
  const lines = script.replace(/\r/g, "").split("\n");
  let heredoc: string | null = null;
  lines.forEach((line, index) => {
    const number = index + 1;
    // The body of a here-document is text, not commands.
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      return;
    }
    const opens = /<<-?\s*['"]?(\w+)['"]?/.exec(line);
    if (opens) heredoc = opens[1];
    if (line.trim().startsWith("#")) return;

    for (const [pattern, key] of DANGERS) {
      if (pattern.test(line)) {
        issues.push({ level: "warn", line: number, text: t(key) });
        break;
      }
    }
    for (const command of commands(line)) {
      const lead = LEADING.exec(command.text)?.[0] ?? "";
      const rest = command.text.slice(lead.length).trimEnd();
      if (!rest) continue;
      // A misspelt command or subcommand; only the words that were typed are changed.
      const fix = findFix(rest + " ", false);
      const corrected = fix?.line.trimEnd();
      if (corrected && corrected !== rest) {
        const typed = rest.split(/\s+/);
        const meant = corrected.split(/\s+/);
        const word = typed.findIndex((w, i) => w !== meant[i]);
        if (word >= 0 && meant[word]) {
          const start = command.at + lead.length;
          const fixed = line.slice(0, start) + corrected + line.slice(start + rest.length);
          issues.push({
            level: "info",
            line: number,
            text: t("lint.typo", { typed: typed[word], meant: meant[word] }),
            fix: lines.map((l, i) => (i === index ? fixed : l)).join("\n"),
          });
        }
      }
      if (ASKS_YES.test(rest) && !SAID_YES.test(` ${rest}`)) {
        const fixed = line.replace(ASKS_YES, (found) => `${found} -y`);
        issues.push({
          level: "info",
          line: number,
          text: t("lint.asks_yes"),
          fix: lines.map((l, i) => (i === index ? fixed : l)).join("\n"),
        });
      }
      if (/^(passwd|read)\b/.test(rest)) {
        issues.push({ level: "info", line: number, text: t("lint.waits_input") });
      }
    }
  });
  return issues;
}

/** bash's words for a syntax error, put plainly where they are common. */
export function syntaxText(error: string, locale: Locale): string {
  const t = (key: MessageKey, vars?: Record<string, string>) => translate(locale, key, vars);
  const quote = /matching [`'](.)'/.exec(error);
  if (quote) return t("lint.syntax.quote", { quote: quote[1] });
  if (/unexpected end of file/.test(error)) return t("lint.syntax.eof");
  const token = /unexpected token [`'](.+)'/.exec(error);
  if (token) return t("lint.syntax.token", { token: token[1] });
  return error;
}
