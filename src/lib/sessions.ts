// Terminal sessions: one xterm.js instance per tab, wired to a core session.
//
// Terminals live outside React so their screen survives tab switches and
// reconnections. Tab metadata (status, prompts) is mirrored into the UI store.

import { Channel } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { api, asApiError, type Id, type PromptReply, type SessionEvent } from "./api";
import { forgetTab } from "./external";
import { Highlighter, type HighlightColors } from "./highlight";
import { t } from "./i18n";
import { WINDOWS } from "./platform";
import { fontStack, isDark, onSystemThemeChange, useSettings, type Settings, cursorColorOf, type CursorColor } from "./settings";
import { useRecent } from "./recent";
import { hostMayType, shareOutput, shareResize, stopShare } from "./share";
import { hostTitle, LOCAL_HOST_ID, useUi, useVault, type Tab } from "./store";
import { Suggester } from "./suggest";
import { resolveTermTheme } from "./themes";

/** Delays before automatic reconnection attempts, in seconds. */
const RECONNECT_DELAYS = [1, 2, 4, 8, 15, 30, 30, 30];
/** A shell that ends sooner than this after connecting keeps its tab open,
 *  so a message printed right before exit can still be read. */
const QUICK_EXIT_MS = 1500;
const ACK_DELAY_MS = 30;
/** Errors after which trying again could plausibly work. */
const TRANSIENT = new Set(["connect", "timeout", "ssh", "io"]);

export function terminalOptions(s: Settings) {
  return {
    fontFamily: fontStack(s.fontFamily),
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    theme: withCursor(resolveTermTheme(s.termTheme, isDark(s.theme)).colors, s.cursorColor),
  } as const;
}

/** The scheme with the cursor in the chosen colour; a block cursor shows its letter in the background colour. */
function withCursor<T extends { cursor?: string; cursorAccent?: string; foreground?: string; background?: string }>(
  colors: T,
  choice: CursorColor,
): T {
  if (choice === "scheme") return colors;
  return { ...colors, cursor: cursorColorOf(choice, colors), cursorAccent: colors.background ?? colors.cursorAccent };
}

/** The colours of the terminal's own scheme, so highlights belong to it. */
export function highlightColors(s: Settings): HighlightColors {
  const theme = resolveTermTheme(s.termTheme, isDark(s.theme)).colors;
  const hex = (color: string | undefined, fallback: string) =>
    color && /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
  return {
    ip: hex(theme.magenta, "#c592ff"),
    error: hex(theme.red, "#f2595e"),
    warning: hex(theme.yellow, "#f2bd4b"),
    success: hex(theme.green, "#4bd396"),
    url: hex(theme.blue, "#6aa9ff"),
  };
}

/** How soon the hint under a link appears; the system's own tooltips take far longer. */
const LINK_TIP_MS = 120;
let linkTip: HTMLDivElement | null = null;
let linkTipTimer: number | undefined;

/** Says, beside the pointer, how a link in the terminal is opened. */
function showLinkTip(event: MouseEvent) {
  const { clientX, clientY } = event;
  window.clearTimeout(linkTipTimer);
  linkTipTimer = window.setTimeout(() => {
    linkTip ??= document.body.appendChild(Object.assign(document.createElement("div"), { className: "link-tip" }));
    linkTip.textContent = t("term.link.hint");
    linkTip.hidden = false;
    // Below and to the right of the pointer, kept inside the window.
    const left = Math.min(clientX + 12, window.innerWidth - linkTip.offsetWidth - 8);
    const top = Math.min(clientY + 18, window.innerHeight - linkTip.offsetHeight - 8);
    linkTip.style.left = `${Math.max(8, left)}px`;
    linkTip.style.top = `${Math.max(8, top)}px`;
  }, LINK_TIP_MS);
}

function hideLinkTip() {
  window.clearTimeout(linkTipTimer);
  if (linkTip) linkTip.hidden = true;
}

export class TermSession {
  readonly term: Terminal;
  readonly search = new SearchAddon();
  private readonly fit = new FitAddon();

  private sessionId: number | null = null;
  /** Bumped on every connection attempt; events of older attempts are dropped. */
  private generation = 0;
  private opened = false;
  private started = false;
  /** The startup snippet runs once per tab, on the first connection only. */
  private startupPending = true;
  private disposed = false;
  private connectedAt = 0;

  private input = "";
  private writing = false;
  private ackPending = 0;
  private ackTimer: number | undefined;

  private reconnectAttempt = 0;
  private reconnectTimer: number | undefined;
  /** Working directory announced by the remote shell (OSC 7), if it does that. */
  private announcedDir: string | null = null;
  /** When the host was last told that a guest has the keyboard. */
  private heldBackAt = 0;
  readonly suggester = new Suggester(this);
  private readonly highlighter: Highlighter;
  private links: WebLinksAddon | null = null;

  /** A snippet to run once the first connection is up: run on several hosts at once. */
  private pendingRun: string | null = null;

  constructor(
    readonly tabId: string,
    readonly hostId: Id,
    run: string | null = null,
  ) {
    this.pendingRun = run;
    this.term = new Terminal({
      ...terminalOptions(useSettings.getState()),
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollOnUserInput: true,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.highlighter = new Highlighter(this.term);
    this.applyHighlighting(useSettings.getState());
    this.applyLinks(useSettings.getState());

    this.term.parser.registerOscHandler(7, (data) => {
      try {
        const path = decodeURIComponent(new URL(data).pathname);
        if (path.startsWith("/")) this.announcedDir = path;
      } catch {
        // Not a file URL; ignore.
      }
      return true;
    });
    this.term.attachCustomKeyEventHandler((event) => this.windowsKey(event) && this.suggester.handleKey(event));
    this.term.onData((data) => this.onInput(data));
    this.term.onResize(({ cols, rows }) => {
      if (this.sessionId !== null) void api.sessionResize(this.sessionId, cols, rows).catch(() => {});
      shareResize(this.tabId, cols, rows);
    });
    this.term.onSelectionChange(() => {
      if (!useSettings.getState().copyOnSelect) return;
      const selection = this.term.getSelection();
      if (selection) void writeText(selection).catch(() => {});
    });
  }

  patch(patch: Partial<Tab>) {
    useUi.getState().patchTab(this.tabId, patch);
  }

  tab(): Tab | undefined {
    return useUi.getState().tabs.find((tab) => tab.id === this.tabId);
  }

  /** Attaches the terminal to its element; the first call starts connecting. */
  mount(element: HTMLElement) {
    if (!this.opened) {
      this.term.open(element);
      this.opened = true;
    }
    this.refit();
    if (!this.started) {
      this.started = true;
      void this.connect();
    }
  }

  refit() {
    if (!this.opened) return;
    try {
      this.fit.fit();
    } catch {
      // The element is not laid out yet (hidden tab); the next call fits.
    }
  }

  focus() {
    this.term.focus();
  }

  applySettings(s: Settings) {
    Object.assign(this.term.options, terminalOptions(s));
    this.applyHighlighting(s);
    this.applyLinks(s);
    this.refit();
  }

  /**
   * Web addresses in the output become links: under the pointer they are
   * underlined, and a click with Cmd (or Ctrl) held opens them in the
   * browser. A plain click stays what it is in a terminal.
   */
  private applyLinks(s: Settings) {
    if (s.terminalLinks && !this.links) {
      this.links = new WebLinksAddon(
        (event, uri) => {
          // Asked again here: a link found before the setting was switched
          // off must not open after it.
          if (!useSettings.getState().terminalLinks) return;
          if (event.metaKey || event.ctrlKey) void api.openLink(uri).catch(() => {});
        },
        { hover: (event) => showLinkTip(event), leave: hideLinkTip },
      );
      this.term.loadAddon(this.links);
    } else if (!s.terminalLinks && this.links) {
      this.links.dispose();
      this.links = null;
      hideLinkTip();
    }
  }

  private applyHighlighting(s: Settings) {
    this.highlighter.configure(
      { ip: s.highlightIp, status: s.highlightStatus, urls: s.terminalLinks },
      highlightColors(s),
    );
  }

  private note(text: string) {
    this.term.write(`\r\n\x1b[90m— ${text} —\x1b[0m\r\n`);
  }

  async connect() {
    if (this.disposed) return;
    this.clearReconnectTimer();
    const generation = ++this.generation;
    this.sessionId = null;
    this.announcedDir = null;
    this.suggester.reset();
    this.input = "";
    this.ackPending = 0;
    this.patch({
      status: "connecting",
      stage: "connecting",
      prompt: null,
      closed: null,
      log: [],
      reconnect: null,
      gaveUp: null,
    });

    const events = new Channel<SessionEvent>();
    events.onmessage = (event) => {
      if (generation === this.generation && !this.disposed) this.onEvent(event);
    };
    const output = new Channel<ArrayBuffer>();
    output.onmessage = (buffer) => {
      if (generation !== this.generation || this.disposed) return;
      const data = new Uint8Array(buffer);
      this.term.write(data, () => {
        if (generation !== this.generation) return;
        this.ack(data.length);
        // Guests of a shared session get it in the order it was drawn here.
        shareOutput(this.tabId, data);
      });
    };

    try {
      const runStartup = this.startupPending;
      this.startupPending = false;
      const id =
        this.hostId === LOCAL_HOST_ID
          ? await api.localTerminal(this.term.cols, this.term.rows, events, output)
          : await api.sessionOpen(this.hostId, this.term.cols, this.term.rows, runStartup, events, output);
      if (generation !== this.generation || this.disposed) {
        void api.sessionClose(id);
        return;
      }
      this.sessionId = id;
      this.flushAck();
    } catch (e) {
      if (generation === this.generation) {
        this.onEvent({ type: "closed", reason: "failed", exit_status: null, error: asApiError(e) });
      }
    }
  }

  private onEvent(event: SessionEvent) {
    switch (event.type) {
      case "stage":
        this.patch({ stage: event.stage });
        break;
      case "prompt":
        this.patch({ prompt: { id: event.id, prompt: event.prompt } });
        break;
      case "log":
        this.patch({ log: [...(this.tab()?.log ?? []), { at: Date.now(), entry: event.entry }] });
        break;
      case "banner":
        this.term.write(event.text.replace(/\r?\n/g, "\r\n"));
        break;
      case "connected": {
        const reconnected = this.reconnectAttempt > 0;
        this.connectedAt = Date.now();
        this.reconnectAttempt = 0;
        this.patch({ status: "connected", stage: null, prompt: null, everConnected: true });
        if (this.hostId !== LOCAL_HOST_ID) useRecent.getState().note(this.hostId);
        if (reconnected) this.note(t("term.reconnected"));
        // The window may have been resized while connecting.
        if (this.sessionId !== null) {
          void api.sessionResize(this.sessionId, this.term.cols, this.term.rows).catch(() => {});
        }
        if (useUi.getState().active === this.tabId) this.focus();
        if (this.pendingRun) {
          const script = this.pendingRun;
          this.pendingRun = null;
          this.run(script);
        }
        break;
      }
      case "closed":
        this.onClosed(event);
        break;
    }
  }

  private onClosed(event: Extract<SessionEvent, { type: "closed" }>) {
    const wasConnected = this.tab()?.status === "connected";
    // A shared session lasts as long as the session itself.
    stopShare(this.tabId);
    this.sessionId = null;
    this.input = "";
    this.suggester.reset();

    // A finished shell closes its tab, unless that would discard an open editor.
    const editing = this.tab()?.editor != null;
    if (event.reason === "exited" && !editing && Date.now() - this.connectedAt > QUICK_EXIT_MS) {
      closeTab(this.tabId);
      return;
    }

    if (event.reason === "exited") {
      this.note(
        event.exit_status
          ? t("term.ended.status", { status: event.exit_status })
          : t("term.ended"),
      );
    } else if (event.reason === "lost") {
      this.note(t("term.lost"));
    }

    this.patch({
      status: "closed",
      stage: null,
      prompt: null,
      closed: {
        reason: event.reason,
        exit_status: event.exit_status,
        error: event.error,
        at: Date.now(),
      },
    });

    const retrying = this.reconnectAttempt > 0;
    const transient = event.error === null || TRANSIENT.has(event.error.code);
    const dropped = event.reason === "lost" && wasConnected;
    const retryFailed = event.reason === "failed" && retrying && transient;
    if (useSettings.getState().autoReconnect && (dropped || retryFailed)) {
      this.scheduleReconnect();
    } else {
      this.reconnectAttempt = 0;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectAttempt >= RECONNECT_DELAYS.length) {
      this.patch({ reconnect: null, gaveUp: this.reconnectAttempt });
      this.reconnectAttempt = 0;
      return;
    }
    const delay = RECONNECT_DELAYS[this.reconnectAttempt] * 1000;
    this.reconnectAttempt += 1;
    this.patch({ reconnect: { attempt: this.reconnectAttempt, at: Date.now() + delay } });
    this.reconnectTimer = window.setTimeout(() => void this.connect(), delay);
  }

  private clearReconnectTimer() {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /** Reconnects now, on the user's request. */
  reconnect() {
    this.reconnectAttempt = 0;
    void this.connect();
  }

  stopReconnecting() {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.patch({ reconnect: null });
  }

  /** Abandons a connection attempt that is still in progress. */
  cancelConnecting() {
    if (this.sessionId !== null) void api.sessionClose(this.sessionId);
  }

  reply(reply: PromptReply) {
    const prompt = this.tab()?.prompt;
    if (!prompt || this.sessionId === null) return;
    this.patch({ prompt: null });
    void api.sessionReply(this.sessionId, prompt.id, reply).catch(() => {});
  }

  /** Puts text on the command line without running it. */
  insert(text: string) {
    if (this.tab()?.status !== "connected") return;
    this.suggester.external();
    this.term.paste(text.replace(/\n+$/, ""));
    this.focus();
  }

  /** Types text and presses Enter after every line. */
  run(text: string) {
    if (this.tab()?.status !== "connected") return;
    const typed = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").replace(/\n/g, "\r");
    // Run as a whole; it is not something the user is typing.
    this.suggester.reset();
    this.type(`${typed}\r`);
    this.focus();
  }

  /**
   * The terminal's working directory on the server: asked from the server
   * for this very session, else what the shell last announced, else unknown.
   */
  async workingDirectory(): Promise<string | null> {
    const id = this.liveSessionId;
    if (id === null) return null;
    try {
      const probed = await api.sessionCwd(id);
      if (probed) return probed;
    } catch {
      // Fall through to what the shell told us.
    }
    return this.announcedDir;
  }

  /** The id of the live core session, while connected. */
  get liveSessionId(): number | null {
    return this.tab()?.status === "connected" ? this.sessionId : null;
  }

  /**
   * On Windows, Ctrl with C and V is how one copies and pastes, and it is
   * also how a terminal is told to interrupt or to take the next key
   * literally. As in Windows' own terminal: Ctrl+C copies when something
   * is selected and interrupts otherwise, and Ctrl+V pastes. Returns
   * `false` when the key was used here and must not reach the shell.
   */
  private windowsKey(event: KeyboardEvent): boolean {
    if (!WINDOWS || event.type !== "keydown" || !event.ctrlKey || event.altKey) return true;
    const key = event.key.toLowerCase();
    if (key === "c" && this.term.hasSelection()) {
      void writeText(this.term.getSelection()).catch(() => {});
      this.term.clearSelection();
      event.preventDefault();
      return false;
    }
    // Left alone by the terminal, the key goes on to paste as it does anywhere else.
    return key !== "v";
  }

  private onInput(data: string) {
    const tab = this.tab();
    if (!tab) return;
    if (tab.status === "closed") {
      if (data === "\r" && tab.prompt === null) this.reconnect();
      return;
    }
    if (tab.status !== "connected") return;
    // In a shared session one person types; right now it is a guest.
    if (!hostMayType(this.tabId)) {
      this.suggester.reset();
      if (Date.now() - this.heldBackAt > 4000) {
        this.heldBackAt = Date.now();
        useUi.getState().toast("info", t("share.held_back"));
      }
      return;
    }
    this.suggester.onInput(data);
    this.type(data);
  }

  /** Sends text to the shell exactly as if it had been typed. */
  type(data: string) {
    if (this.tab()?.status !== "connected") return;
    this.input += data;
    if (!this.writing) void this.flushInput();
  }

  // Input is sent one request at a time so keystrokes cannot overtake each
  // other; whatever accumulates meanwhile goes out as one piece.
  private async flushInput() {
    this.writing = true;
    try {
      while (this.input && this.sessionId !== null) {
        const chunk = this.input;
        this.input = "";
        await api.sessionWrite(this.sessionId, chunk);
      }
    } catch {
      this.input = "";
    } finally {
      this.writing = false;
    }
  }

  private ack(bytes: number) {
    this.ackPending += bytes;
    if (this.ackTimer === undefined) {
      this.ackTimer = window.setTimeout(() => this.flushAck(), ACK_DELAY_MS);
    }
  }

  private flushAck() {
    window.clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (this.sessionId === null || this.ackPending === 0) return;
    void api.sessionAck(this.sessionId, this.ackPending).catch(() => {});
    this.ackPending = 0;
  }

  clear() {
    this.term.clear();
  }

  dispose() {
    this.disposed = true;
    this.clearReconnectTimer();
    window.clearTimeout(this.ackTimer);
    if (this.sessionId !== null) void api.sessionClose(this.sessionId);
    this.sessionId = null;
    this.highlighter.dispose();
    hideLinkTip();
    this.term.dispose();
  }
}

const sessions = new Map<string, TermSession>();
let tabSeq = 1;

export function getSession(tabId: string): TermSession | undefined {
  return sessions.get(tabId);
}

/** Opens a new terminal tab for the host; `run` is a snippet to run once it is connected. */
export function openHost(hostId: Id, run: string | null = null) {
  const host = useVault.getState().snapshot.hosts.find((h) => h.id === hostId);
  if (!host) return;
  openTab(hostId, hostTitle(host), run);
}

/** Opens a new tab with a terminal on this computer. */
export function openLocal() {
  openTab(LOCAL_HOST_ID, t("local.title"));
}

function openTab(hostId: Id, title: string, run: string | null = null) {
  const id = `tab-${tabSeq++}`;
  sessions.set(id, new TermSession(id, hostId, run));
  useUi.getState().addTab({
    id,
    hostId,
    title,
    status: "connecting",
    // A local terminal goes through no stages of connecting.
    stage: hostId === LOCAL_HOST_ID ? null : "connecting",
    prompt: null,
    closed: null,
    log: [],
    everConnected: false,
    reconnect: null,
    gaveUp: null,
    searchOpen: false,
    side: null,
    files: false,
    filesDir: null,
    editor: null,
    editorDirty: false,
    editorClosing: null,
    suggest: null,
  });
}

/**
 * Closes a tab on the user's request. Unsaved editor changes are never
 * dropped silently: the editor is asked to confirm first.
 */
export function requestCloseTab(tabId: string) {
  const tab = useUi.getState().tabs.find((candidate) => candidate.id === tabId);
  if (tab?.editor && tab.editorDirty) {
    useUi.getState().patchTab(tabId, { editorClosing: "tab" });
    useUi.getState().activate(tabId);
    return;
  }
  closeTab(tabId);
}

/** Closes the editor of a tab, asking first if it has unsaved changes. */
export function requestCloseEditor(tabId: string) {
  const ui = useUi.getState();
  const tab = ui.tabs.find((candidate) => candidate.id === tabId);
  if (!tab?.editor) return;
  if (tab.editorDirty) ui.patchTab(tabId, { editorClosing: "editor" });
  else ui.patchTab(tabId, { editor: null, editorDirty: false, editorClosing: null });
}

export function closeTab(tabId: string) {
  stopShare(tabId);
  forgetTab(tabId);
  sessions.get(tabId)?.dispose();
  sessions.delete(tabId);
  useUi.getState().removeTab(tabId);
}

function applyToAll() {
  const settings = useSettings.getState();
  for (const session of sessions.values()) session.applySettings(settings);
}

/** Keeps open terminals in step with settings, theme and host renames. */
export function startSessionSync() {
  useSettings.subscribe(applyToAll);
  onSystemThemeChange(applyToAll);
  useVault.subscribe((state) => {
    const ui = useUi.getState();
    for (const tab of ui.tabs) {
      const host = state.snapshot.hosts.find((h) => h.id === tab.hostId);
      if (host && hostTitle(host) !== tab.title) ui.patchTab(tab.id, { title: hostTitle(host) });
    }
  });
}
