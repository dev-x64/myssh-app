// Suggestions while typing a command: history (this host first), remote
// paths, snippets, containers the terminal has shown, well-known commands
// and the subcommands of tools, plus a correction when a command looks
// misspelt. When none of them has anything for the line, the list offers to
// ask the AI (through the cloud server, within what the account's plan
// allows) for commands that do what the line says in words; it is asked
// only when that is chosen.
//
// What is on the command line is followed without touching the shell. Plain
// typing is tracked directly; once the shell itself edits the line (history
// recall, Tab completion) the text is read back from the terminal screen.

import type { Terminal } from "@xterm/xterm";
import { api, type AiSuggestion, type FileEntry, type Id } from "./api";
import { containerBeingTyped, Containers } from "./containers";
import { loadPlan, usePlan } from "./plan";
import { redact } from "./redact";
import { formatClock, translate } from "./i18n";
import { useSettings } from "./settings";
import { useVault, type SuggestState, type Suggestion, type Tab } from "./store";
import { subcommandsAt } from "./subcommands";
import { findFix, knownCommands, looksLikeCommand } from "./typos";

const DEBOUNCE_MS = 90;
const LIST_TTL_MS = 4000;
/** What the list shows before it scrolls. */
const MAX_ITEMS = 8;
/** Well-known commands only fill what room is left, and never the whole list. */
const MAX_KNOWN = 5;
/** Entries of a directory; the list scrolls through them. */
const MAX_PATHS = 40;
/** Shorter lines say too little to ask about. */
const AI_MIN_LETTERS = 3;
/** Lines of the screen above the command line sent along with it, and how much of them. */
const AI_CONTEXT_LINES = 15;
const AI_CONTEXT_CHARS = 1500;
const MAX_CONTAINERS = 5;
/** A container is offered once this much of its name has been typed. */
const CONTAINER_LETTERS = 2;
/** Commands whose arguments are usually files. */
const FILE_COMMANDS = new Set([
  "cd", "ls", "ll", "cat", "less", "more", "head", "tail", "vi", "vim", "nvim", "nano", "rm", "cp",
  "mv", "mkdir", "rmdir", "touch", "chmod", "chown", "source", "du", "stat", "file", "tar", "unzip",
  "grep", "diff", "ln", "pushd", "bat", "open",
]);
const DIR_COMMANDS = new Set(["cd", "pushd", "rmdir"]);
/** A prompt for something secret, just before where typing began: `Password:`, `[sudo] password for me:`, `Enter passphrase for key …:`. */
const SECRET_PROMPT = /(password|passphrase|passcode|pin|token|secret|пароль|парольн\S*)[^:：]*[:：]\s*$/i;
/** How long to wait for the server to echo what was typed before taking it as not echoed. */
const ECHO_WAIT_MS = 250;
const ECHO_WAITS = 6;

/**
 * Until when the AI is not to be asked, for every terminal at once: the
 * plan's allowance is used up, or the server has the AI switched off.
 */
const aiPause = { until: 0, plan: null as string | null };
/** How long asking the AI is not offered once the server says it is off. */
const AI_OFF_PAUSE_MS = 10 * 60_000;



/** What the suggester needs from the session it serves. */
export interface SuggestHost {
  readonly term: Terminal;
  readonly hostId: Id;
  readonly liveSessionId: number | null;
  tab(): Tab | undefined;
  patch(patch: Partial<Tab>): void;
  workingDirectory(): Promise<string | null>;
  /** Sends text exactly as if it had been typed. */
  type(text: string): void;
}

function shellEscape(text: string): string {
  return text.replace(/([\s\\'"()&;|<>*?$`!#[\]{}])/g, "\\$1");
}

export class Suggester {
  /** Screen position where the command being typed begins. */
  private start: { row: number; col: number } | null = null;
  private typed = "";
  /** Only plain typing so far, so `typed` is exactly what is on the line. */
  private simple = true;
  private timer: number | undefined;
  private ticket = 0;
  /** `undefined` means "not asked yet for this command line". */
  private cwd: string | null | undefined;
  private home: string | null | undefined;
  private listings = new Map<string, { at: number; entries: FileEntry[] }>();
  private containers: Containers | null = null;
  private aiTicket = 0;
  /** What the AI said about each line already asked about. */
  private aiAnswers = new Map<string, AiSuggestion[]>();
  /** The account's login shell on the server; `undefined` until asked. */
  private shell: string | null | undefined;
  /** How many times the list waited for the server's echo of this line. */
  private echoWaits = 0;

  constructor(private readonly host: SuggestHost) {}

  private get enabled(): boolean {
    return useSettings.getState().suggestions && this.host.term.buffer.active.type === "normal";
  }

  /** Call with every piece of input before it is sent. */
  onInput(data: string) {
    if (!this.enabled) {
      this.reset();
      return;
    }
    if (data === "\r") {
      this.commit();
      return;
    }
    if (data === "\x03" || data === "\x04") {
      this.reset();
      return;
    }
    const buffer = this.host.term.buffer.active;
    if (this.start === null) {
      this.start = { row: buffer.baseY + buffer.cursorY, col: buffer.cursorX };
    }
    if (data === "\x15") this.typed = "";
    else if (data === "\x7f") this.typed = [...this.typed].slice(0, -1).join("");
    else if (data === "\x17") this.typed = this.typed.replace(/\S+\s*$/, "");
    // eslint-disable-next-line no-control-regex
    else if (!/[\x00-\x1f\x7f]/.test(data)) this.typed += data;
    else this.simple = false;
    this.schedule();
  }

  /**
   * Something other than the keyboard is about to change the command line
   * (a snippet being inserted). From here on the line is read from the
   * screen rather than assumed.
   */
  external() {
    if (!this.enabled) return;
    const buffer = this.host.term.buffer.active;
    if (this.start === null) {
      this.start = { row: buffer.baseY + buffer.cursorY, col: buffer.cursorX };
    }
    this.simple = false;
    this.hide();
  }

  /** Text between the start of the command and the cursor, as displayed. */
  private screenText(): string {
    if (!this.start) return "";
    const buffer = this.host.term.buffer.active;
    const endRow = buffer.baseY + buffer.cursorY;
    let text = "";
    for (let row = this.start.row; row <= endRow; row++) {
      const line = buffer.getLine(row);
      if (!line) break;
      const from = row === this.start.row ? this.start.col : 0;
      const to = row === endRow ? buffer.cursorX : undefined;
      text += line.translateToString(false, from, to);
    }
    return text;
  }

  private currentInput(): string {
    return this.simple ? this.typed : this.screenText();
  }

  /**
   * Whether what is being typed is kept off the screen: it follows a
   * prompt for a password or the like, or the server shows none of it.
   * Nothing is suggested for it, and nothing of it is looked up or sent.
   */
  private secret(): boolean {
    if (!this.start) return false;
    const line = this.host.term.buffer.active.getLine(this.start.row);
    if (SECRET_PROMPT.test(line?.translateToString(false, 0, this.start.col) ?? "")) return true;
    return this.unechoed();
  }

  /** Typed, but none of it is on the screen. */
  private unechoed(): boolean {
    return this.simple && this.typed.trim() !== "" && this.screenText().trim() === "";
  }

  /**
   * Enter was pressed: remember the command.
   *
   * A command is remembered only if the terminal displayed it. Input the
   * server did not echo, such as a password at a sudo prompt, shows up as
   * nothing on screen and is therefore never recorded.
   */
  private commit() {
    let command = "";
    if (this.start) {
      const shown = this.screenText().trimEnd();
      if (!this.simple) {
        command = shown;
      } else if (shown.trim()) {
        const typed = this.typed.trim();
        // The echo of the last keystrokes may still be on its way.
        if (typed.startsWith(shown.trim()) || shown.trim().startsWith(typed)) command = this.typed;
      }
    }
    this.reset();
    if (command.trim()) void api.historyRecord(this.host.hostId, command).catch(() => {});
  }

  reset() {
    window.clearTimeout(this.timer);
    this.ticket += 1;
    this.aiTicket += 1;
    this.start = null;
    this.typed = "";
    this.simple = true;
    this.cwd = undefined;
    this.echoWaits = 0;
    this.hide();
  }

  hide() {
    if (this.host.tab()?.suggest) this.host.patch({ suggest: null });
  }

  private schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.refresh(), DEBOUNCE_MS);
    // An answer still on its way is for a line that is no longer there.
    this.aiTicket += 1;
  }

  private async refresh() {
    const mine = ++this.ticket;
    const input = this.currentInput().trimStart();
    if (!this.start || input.trim().length < 2 || this.host.liveSessionId === null || this.secret()) {
      this.hide();
      // The echo of a slow server may simply not be here yet: look again a little later.
      if (this.start && this.unechoed() && this.echoWaits < ECHO_WAITS) {
        this.echoWaits += 1;
        this.timer = window.setTimeout(() => {
          if (mine === this.ticket) void this.refresh();
        }, ECHO_WAIT_MS);
      }
      return;
    }
    const [history, paths] = await Promise.all([
      api.historySuggest(this.host.hostId, input, 6).catch(() => []),
      this.pathItems(input).catch(() => []),
    ]);
    if (mine !== this.ticket) return;

    const fromHistory = (own: boolean): Suggestion[] =>
      history
        .filter((entry) => entry.this_host === own)
        .map((entry) => ({
          kind: "history",
          label: entry.command,
          match: entry.command.startsWith(input) ? input.length : 0,
          insert: entry.command.slice(input.length),
        }));
    const lowered = input.toLowerCase();
    const snippets: Suggestion[] = useVault
      .getState()
      .snapshot.snippets.filter(
        (snippet) =>
          snippet.name.toLowerCase().startsWith(lowered) || snippet.script.startsWith(input),
      )
      .slice(0, 3)
      .map((snippet) => {
        const script = snippet.script.replace(/\n+$/, "");
        const continues = !script.includes("\n") && script.startsWith(input);
        return {
          kind: "snippet",
          label: snippet.name,
          match: snippet.name.toLowerCase().startsWith(lowered) ? input.length : 0,
          detail: script.split("\n")[0],
          insert: continues ? script.slice(input.length) : script,
          replace: !continues,
        };
      });

    const describe = (entry: { en: string; ru: string }) =>
      useSettings.getState().locale === "ru" ? entry.ru : entry.en;
    // A command name that has been run before is taken as it is.
    const fix = findFix(input, history.length > 0);
    const fixes: Suggestion[] = fix
      ? [
          { kind: "fix", label: fix.line.trimEnd(), insert: fix.line, replace: true },
          ...fix.completions.map(
            ({ entry, label }): Suggestion => ({
              kind: "fix",
              label,
              detail: describe(entry),
              insert: label,
              replace: true,
            }),
          ),
        ]
      : [];
    const known: Suggestion[] = knownCommands(input, MAX_KNOWN * 3).map(({ entry, label }) => ({
      kind: "command",
      label,
      match: input.length,
      detail: describe(entry),
      insert: label.slice(input.length),
    }));
    // A subcommand goes in with a space after it, so that what it takes, or
    // its own subcommands, can follow.
    const at = subcommandsAt(input);
    const before = at ? input.slice(0, input.length - at.typed.length) : "";
    const subcommands: Suggestion[] = (at?.found ?? []).map((sub) => ({
      kind: "subcommand",
      label: sub.name,
      match: at!.typed.length,
      args: sub.args,
      detail: describe(sub),
      insert: `${sub.name.slice(at!.typed.length)} `,
    }));
    // A well-known command that is just a subcommand is offered as that.
    const plain = new Set(subcommands.map((sub) => before + sub.label));

    // The same command is offered once, from the most personal source.
    const seen = new Set<string>();
    const fresh = (item: Suggestion) => {
      const apart = item.kind === "path" || item.kind === "snippet" || item.kind === "container";
      const key = apart ? `${item.kind}:${item.label}` : item.label.trim();
      return item.insert !== "" && !seen.has(key) && seen.add(key);
    };
    const personal = [...fixes, ...this.containerItems(input), ...fromHistory(true), ...paths, ...fromHistory(false), ...snippets]
      .filter(fresh);
    const room = Math.min(MAX_KNOWN, MAX_ITEMS - personal.length);
    const local = [
      ...personal,
      ...known.filter((item) => !plain.has(item.label.trim()) && fresh(item)).slice(0, Math.max(0, room)),
      ...subcommands,
    ];
    // An answer the AI already gave for this very line stays in the list;
    // with nothing else to offer, asking it is offered.
    const answered = this.aiAnswers.get(input.trim());
    if (answered) this.show(this.withAi(local, answered, input, -1), -1);
    else if (local.length === 0 && this.aiOffered(this.currentInput())) this.show([this.askItem(input)], -1);
    else this.show(local, -1);
  }

  /**
   * The row that asks the AI: nothing goes on the line, the AI is asked.
   * Words are turned into a command; about a command, the AI is just asked.
   */
  private askItem(input: string): Suggestion {
    const key = looksLikeCommand(input) ? "suggest.ai_ask_command" : "suggest.ai_ask";
    return { kind: "ask", label: translate(useSettings.getState().locale, key), insert: "" };
  }

  /**
   * Whether asking the AI about this line is offered: it may be asked, the
   * line says enough, and was not typed with a leading space (which keeps
   * a line out of history, and out of this too).
   */
  private aiOffered(raw: string): boolean {
    const input = raw.trim();
    // Switched off, or used up and already said so once: not offered until
    // the allowance comes back (the account menu says when).
    const off = Date.now() < aiPause.until;
    return (
      this.aiAllowed &&
      !off &&
      !/^\s/.test(raw) &&
      input.replace(/\s/g, "").length >= AI_MIN_LETTERS &&
      input.length <= 500
    );
  }

  private show(items: Suggestion[], index: number, note?: string) {
    if (items.length === 0 && !note) {
      this.hide();
      return;
    }
    const buffer = this.host.term.buffer.active;
    this.host.patch({ suggest: { items, index, note, col: buffer.cursorX, row: buffer.cursorY } });
  }

  /**
   * The AI's commands put in with the others: first while nothing is
   * selected, after them once a row is, so that the selection stays put.
   * A command already offered from elsewhere is not offered twice.
   */
  private withAi(local: Suggestion[], answer: AiSuggestion[], input: string, index: number): Suggestion[] {
    const shown = new Set(local.map((item) => item.label.trim()));
    const ai = answer
      .filter((found) => !shown.has(found.command))
      .map((found): Suggestion => {
        const continues = found.command.startsWith(input);
        return {
          kind: "ai",
          label: found.command,
          match: continues ? input.length : 0,
          detail: found.explanation,
          danger: found.danger,
          insert: continues ? found.command.slice(input.length) : found.command,
          replace: !continues,
        };
      });
    return index < 0 ? [...ai, ...local] : [...local, ...ai];
  }

  /**
   * Whether the AI may be asked: the server has it on for this account,
   * the setting is on, the session is live.
   */
  private get aiAllowed(): boolean {
    return (
      this.enabled &&
      useSettings.getState().aiSuggestions &&
      usePlan.getState().plan?.ai === true &&
      this.host.liveSessionId !== null
    );
  }

  /** What the list says while the allowance is used up. */
  private pauseNote(): string {
    const locale = useSettings.getState().locale;
    const until = formatClock(aiPause.until, locale);
    return translate(locale, aiPause.plan === "free" ? "suggest.ai_limit_free" : "suggest.ai_limit", { time: until });
  }

  /**
   * Asking the AI was chosen: asks about the line, with the system, the
   * shell and a few lines of the screen, secrets taken out of all of it
   * first, and shows its commands with the first one selected.
   */
  private async askAi() {
    if (!this.start || this.secret() || !this.aiOffered(this.currentInput())) return;
    const input = this.currentInput().trim();
    const locale = useSettings.getState().locale;
    const mine = ++this.aiTicket;
    let answer = this.aiAnswers.get(input);
    if (!answer) {
      this.show([], -1, translate(locale, "suggest.ai_thinking"));
      const sid = this.host.liveSessionId!;
      if (this.shell === undefined) this.shell = await api.sessionShell(sid).catch(() => null);
      if (this.cwd === undefined) this.cwd = await this.host.workingDirectory();
      if (mine !== this.aiTicket) return;
      const host = useVault.getState().snapshot.hosts.find((h) => h.id === this.host.hostId);
      const found = await api
        .aiSuggest({
          line: redact(input),
          os: host?.os?.name ?? "",
          shell: this.shell ?? "",
          cwd: redact(this.cwd ?? ""),
          user: host?.auth.kind === "inline" ? host.auth.username : "",
          context: this.screenAbove(),
          locale: useSettings.getState().locale,
        })
        .catch((error: { code?: string; message?: string }) => {
          // The server has the AI off (or not for this plan), or it failed:
          // left alone for a while rather than asked at every pause.
          // The server has the AI off (or not for this plan): not offered for a while.
          if (error?.code === "cloud" && /not available/.test(error.message ?? "")) {
            aiPause.until = Date.now() + AI_OFF_PAUSE_MS;
            aiPause.plan = "off";
            // Switched off since the plan was read: the switch in Settings goes too.
            void loadPlan(true);
          }
          return null;
        });
      if (mine !== this.aiTicket) return;
      if (!found) {
        this.show([], -1, translate(locale, "suggest.ai_failed"));
        return;
      }
      // What is left changed: the account menu learns it.
      void loadPlan(true);
      if (found.limited_until) {
        aiPause.until = found.limited_until * 1000;
        aiPause.plan = found.plan ?? null;
        this.show([], -1, this.pauseNote());
        return;
      }
      answer = found.suggestions;
      this.aiAnswers.set(input, answer);
      if (this.aiAnswers.size > 50) this.aiAnswers.delete(this.aiAnswers.keys().next().value!);
    }
    // The line may have changed while the answer was on its way.
    if (mine !== this.aiTicket || this.currentInput().trim() !== input) return;
    if (answer.length === 0) {
      this.show([], -1, translate(locale, "suggest.ai_nothing"));
      return;
    }
    this.show(this.withAi([], answer, this.currentInput().trimStart(), -1), 0);
  }

  /** The last lines the terminal shows above the command line, secrets taken out. */
  private screenAbove(): string {
    if (!this.start) return "";
    const buffer = this.host.term.buffer.active;
    const lines: string[] = [];
    // The prompt itself (who, where) is the first thing worth seeing.
    const prompt = buffer.getLine(this.start.row)?.translateToString(true, 0, this.start.col) ?? "";
    for (let row = this.start.row - 1; row >= 0 && lines.length < AI_CONTEXT_LINES; row--) {
      const line = buffer.getLine(row)?.translateToString(true) ?? "";
      if (line.trim()) lines.unshift(line.slice(0, 200));
    }
    if (prompt.trim()) lines.push(prompt);
    return redact(lines.join("\n")).slice(-AI_CONTEXT_CHARS);
  }

  /**
   * Containers whose names the terminal has shown, for a command that
   * takes one: those that begin with what is typed, then those that only
   * contain it.
   */
  private containerItems(input: string): Suggestion[] {
    // The session's terminal exists only once the session does.
    this.containers ??= new Containers(this.host.term);
    const names = this.containers.names();
    const typed = containerBeingTyped(input, new Set(names));
    if (typed === null || typed.length < CONTAINER_LETTERS) return [];
    const lowered = typed.toLowerCase();
    const begins = names.filter((name) => name !== typed && name.toLowerCase().startsWith(lowered));
    const contains = names.filter((name) => !begins.includes(name) && name !== typed && name.toLowerCase().includes(lowered));
    const before = input.slice(0, input.length - typed.length);
    return [
      ...begins.map((name): Suggestion => ({ kind: "container", label: name, match: typed.length, insert: name.slice(typed.length) })),
      // What is typed sits in the middle of the name, so the line is written out again.
      ...contains.map((name): Suggestion => ({ kind: "container", label: name, insert: before + name, replace: true })),
    ].slice(0, MAX_CONTAINERS);
  }

  private async listDir(sid: number, dir: string): Promise<FileEntry[]> {
    const cached = this.listings.get(dir);
    if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.entries;
    const entries = await api.sftpList(sid, dir);
    this.listings.set(dir, { at: Date.now(), entries });
    if (this.listings.size > 30) this.listings.delete(this.listings.keys().next().value!);
    return entries;
  }

  /** Completions for the path being typed, read from the server. */
  private async pathItems(input: string): Promise<Suggestion[]> {
    const sid = this.host.liveSessionId;
    if (sid === null) return [];
    const token = /(\S*)$/.exec(input)?.[1] ?? "";
    const words = input.split(/\s+/);
    const command = words[0];
    const pathLike = token.includes("/") || token.startsWith("~") || token.startsWith(".");
    // The first word is a command name, not a path, unless it looks like one.
    if (words.length === 1 && !pathLike) return [];
    if (!pathLike && !FILE_COMMANDS.has(command)) return [];

    const slash = token.lastIndexOf("/");
    const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
    const partial = token.slice(slash + 1);
    if (partial === "~" || partial === "." || partial === "..") return [];

    let dir: string;
    if (dirPart.startsWith("/")) {
      dir = dirPart;
    } else if (dirPart.startsWith("~/")) {
      if (this.home === undefined) this.home = await api.sftpHome(sid).catch(() => null);
      if (!this.home) return [];
      dir = `${this.home}/${dirPart.slice(2)}`;
    } else {
      if (this.cwd === undefined) this.cwd = await this.host.workingDirectory();
      if (!this.cwd) return [];
      dir = `${this.cwd}/${dirPart}`;
    }

    const onlyDirs = DIR_COMMANDS.has(command);
    const entries = await this.listDir(sid, dir);
    return entries
      .filter(
        (entry) =>
          entry.name.startsWith(partial) &&
          (partial.startsWith(".") || !entry.name.startsWith(".")) &&
          (!onlyDirs || entry.is_dir) &&
          (entry.is_dir || entry.name !== partial),
      )
      .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))
      .slice(0, MAX_PATHS)
      .map((entry) => ({
        kind: "path",
        label: `${entry.name}${entry.is_dir ? "/" : ""}`,
        match: partial.length,
        insert: `${shellEscape(entry.name.slice(partial.length))}${entry.is_dir ? "/" : ""}`,
      }));
  }

  private state(): SuggestState | null {
    return this.host.tab()?.suggest ?? null;
  }

  /**
   * Keys while the list is shown. Returns `false` when the key was used
   * here and must not reach the shell.
   *
   * Nothing is taken from the shell until a row is selected with Down:
   * Up keeps recalling shell history and Tab keeps completing as usual.
   */
  handleKey(event: KeyboardEvent): boolean {
    const state = this.state();
    if (!state || event.type !== "keydown") return true;
    if (event.metaKey || event.ctrlKey || event.altKey) return true;
    const consume = () => {
      event.preventDefault();
      return false;
    };
    switch (event.key) {
      case "ArrowDown":
        this.host.patch({
          suggest: { ...state, index: Math.min(state.index + 1, state.items.length - 1) },
        });
        return consume();
      case "ArrowUp":
        if (state.index < 0) return true;
        this.host.patch({ suggest: { ...state, index: state.index - 1 } });
        return consume();
      case "Tab":
      case "Enter":
        if (state.index < 0) {
          if (event.key === "Enter") this.hide();
          return true;
        }
        this.accept(state.index);
        return consume();
      case "Escape":
        // Dismissed: an answer still on its way does not bring it back.
        this.aiTicket += 1;
        this.hide();
        return consume();
      default:
        return true;
    }
  }

  /** Puts a suggestion on the command line. It is never run by this. */
  accept(index: number) {
    const item = this.state()?.items[index];
    if (!item) return;
    if (item.kind === "ask") {
      void this.askAi();
      return;
    }
    this.hide();
    if (item.replace) {
      this.host.type("\x15");
      this.typed = "";
    }
    if (item.insert.includes("\n")) {
      // A multi-line snippet goes in as a paste, so the shell does not run
      // its lines one by one.
      this.host.term.paste(item.insert);
      this.simple = false;
    } else {
      this.host.type(item.insert);
      this.typed += item.insert;
    }
    this.schedule();
  }
}
