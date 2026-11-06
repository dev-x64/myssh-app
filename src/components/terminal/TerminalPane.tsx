import {
  Braces,
  Check,
  Brackets,
  ChevronDown,
  ChevronUp,
  Container,
  File,
  Folder,
  History,
  Sparkles,
  SpellCheck,
  SquareTerminal,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorText, useT, type MessageKey } from "../../lib/i18n";
import { closeTab, getSession, type TermSession } from "../../lib/sessions";
import { dropTarget, useDrag } from "../../lib/drag";
import { MOBILE, WINDOWS } from "../../lib/platform";
import { isDark, useSettings } from "../../lib/settings";
import { useShare } from "../../lib/share";
import { isLocalTab, useUi, useVault, type Suggestion, type Tab } from "../../lib/store";
import { resolveTermTheme } from "../../lib/themes";
import { cx } from "../ui";
import { ConnectScreen, FailedAttempt } from "./ConnectScreen";
import { CursorBadge, personTone } from "./CursorBadge";
import { ExternalConflict } from "./ExternalConflict";
import { FileEditor } from "./FileEditor";
import { FileManager } from "./FileManager";
import { PasswordOffer, PasswordSave } from "./PasswordOffer";
import { PromptDialog } from "./PromptDialog";
import { ShareBar } from "./SharePanel";
import { LocalIntro } from "./LocalIntro";
import { Tip } from "../Tip";
import { TypingDemo } from "./TypingDemo";
import { keyOf } from "../../lib/shortcuts";
import { SnippetsPanel } from "./SnippetsPanel";
import { StatsLine, useServerStats } from "./StatsBar";

/** Advanced mode: the server's load under its terminal, read while it is in sight. */
function LiveStats({ tab, active }: { tab: Tab; active: boolean }) {
  const session = getSession(tab.id);
  const stats = useServerStats(session?.liveSessionId ?? null, active);
  return <StatsLine stats={stats} />;
}

function SearchBox({ tab }: { tab: Tab }) {
  const t = useT();
  const session = getSession(tab.id);
  const patchTab = useUi((s) => s.patchTab);
  const dark = useSettings((s) => isDark(s.theme));
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);

  const options = {
    decorations: {
      matchBackground: dark ? "#5a4a2a" : "#ffe2a8",
      matchOverviewRuler: "#f2bd4b",
      activeMatchBackground: "#ff7a45",
      activeMatchColorOverviewRuler: "#ff7a45",
    },
  };

  useEffect(() => {
    if (!session) return;
    const subscription = session.search.onDidChangeResults((r) =>
      setResult({ index: r.resultIndex, count: r.resultCount }),
    );
    return () => {
      subscription.dispose();
      session.search.clearDecorations();
    };
  }, [session]);

  if (!session) return null;

  const find = (text: string, forward: boolean, incremental = false) => {
    if (!text) {
      session.search.clearDecorations();
      setResult(null);
      return;
    }
    if (forward) session.search.findNext(text, { ...options, incremental });
    else session.search.findPrevious(text, options);
  };

  const close = () => {
    patchTab(tab.id, { searchOpen: false });
    session.focus();
  };

  return (
    <div className="term-search">
      <input
        className="input"
        autoFocus
        value={query}
        placeholder={t("term.search.placeholder")}
        onChange={(e) => {
          setQuery(e.target.value);
          find(e.target.value, true, true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(query, !e.shiftKey);
          if (e.key === "Escape") close();
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <span className="count">
        {query && result ? (result.count ? `${result.index + 1} / ${result.count}` : t("term.search.none")) : ""}
      </span>
      <button className="btn ghost small icon" title={t("term.search.prev")} onClick={() => find(query, false)}>
        <ChevronUp size={15} />
      </button>
      <button className="btn ghost small icon" title={t("term.search.next")} onClick={() => find(query, true)}>
        <ChevronDown size={15} />
      </button>
      <button className="btn ghost small icon" title={t("common.close")} onClick={close}>
        <X size={15} />
      </button>
    </div>
  );
}

function Countdown({ at, attempt }: { at: number; attempt: number }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  return <>{t("term.reconnecting_in", { s: Math.max(0, Math.ceil((at - now) / 1000)), n: attempt })}</>;
}

const SUGGEST_ICONS: Record<Suggestion["kind"], LucideIcon> = {
  history: History,
  path: Folder,
  snippet: Braces,
  command: SquareTerminal,
  fix: SpellCheck,
  container: Container,
  subcommand: Brackets,
  ai: Sparkles,
  ask: WandSparkles,
};

/**
 * The selected suggestion written on the line itself, in grey, after the
 * cursor: what Tab or the right arrow would add. Only while the cursor is
 * at the end of the line, where the list was made for.
 */
function SuggestGhost({ tab }: { tab: Tab }) {
  const session = getSession(tab.id);
  const ref = useRef<HTMLDivElement>(null);
  const state = tab.suggest;
  const fontFamily = useSettings((s) => s.fontFamily);
  const fontSize = useSettings((s) => s.fontSize);
  const foreground = useSettings((s) => resolveTermTheme(s.termTheme, isDark(s.theme)).colors.foreground);
  const [box, setBox] = useState<{ left: number; top: number; cell: number; height: number; room: number } | null>(null);
  // The cursor moves with every echo: the text stays where it is only while it is there.
  const [, moved] = useState(0);
  useEffect(() => {
    if (!session) return;
    const watching = [session.term.onCursorMove(() => moved((n) => n + 1)), session.term.onScroll(() => moved((n) => n + 1))];
    return () => watching.forEach((watch) => watch.dispose());
  }, [session]);

  const item = state && state.index >= 0 ? state.items[state.index] : undefined;
  const buffer = session?.term.buffer.active;
  const shown =
    !!session &&
    !!state &&
    !!item &&
    !!buffer &&
    !item.replace &&
    item.kind !== "ask" &&
    item.insert !== "" &&
    !item.insert.includes("\n") &&
    buffer.viewportY === buffer.baseY &&
    buffer.cursorX === state.col &&
    buffer.cursorY === state.row &&
    !(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true, buffer.cursorX) ?? "").trim();

  useLayoutEffect(() => {
    const wrap = ref.current?.parentElement;
    const screen = wrap?.querySelector<HTMLElement>(".xterm-screen");
    if (!shown || !wrap || !screen || !session || !state) return;
    const origin = wrap.getBoundingClientRect();
    const area = screen.getBoundingClientRect();
    const cell = area.width / session.term.cols;
    const height = area.height / session.term.rows;
    const left = area.left - origin.left + state.col * cell;
    setBox({ left, top: area.top - origin.top + state.row * height, cell, height, room: area.right - origin.left - left });
  }, [shown, session, state]);

  if (!shown || !item) return <div ref={ref} hidden />;
  return (
    <div
      ref={ref}
      className="suggest-ghost"
      aria-hidden
      style={
        box
          ? {
              left: box.left,
              top: box.top,
              height: box.height,
              maxWidth: box.room,
              lineHeight: `${box.height}px`,
              fontFamily: `"${fontFamily}", monospace`,
              fontSize,
              color: foreground,
            }
          : { visibility: "hidden" }
      }
    >
      {[...item.insert].map((char, index) => (
        <span key={index} style={{ width: box?.cell }}>
          {char}
        </span>
      ))}
    </div>
  );
}

/** Suggestions for the command being typed, anchored under the cursor. */
function SuggestList({ tab }: { tab: Tab }) {
  const t = useT();
  const session = getSession(tab.id);
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<React.CSSProperties>({ visibility: "hidden" });
  const state = tab.suggest;

  useLayoutEffect(() => {
    const list = ref.current;
    const wrap = list?.parentElement;
    const screen = wrap?.querySelector<HTMLElement>(".xterm-screen");
    if (!list || !wrap || !screen || !session || !state) return;
    const origin = wrap.getBoundingClientRect();
    const area = screen.getBoundingClientRect();
    const cellWidth = area.width / session.term.cols;
    const cellHeight = area.height / session.term.rows;
    const left = Math.max(
      6,
      Math.min(area.left - origin.left + state.col * cellWidth, origin.width - list.offsetWidth - 6),
    );
    const below = area.top - origin.top + (state.row + 1) * cellHeight + 2;
    // Above the line when there is no room below it, held by its foot there: a row
    // opened in full grows away from the line, and stays under the pointer. The
    // side is chosen by the list's closed height, so opening a row never flips it.
    const height = list.offsetHeight - (list.querySelector<HTMLElement>(".suggest-full")?.offsetHeight ?? 0);
    if (below + height > origin.height - 4) {
      const above = area.top - origin.top + state.row * cellHeight - 2;
      setPlace({ left, bottom: origin.height - above });
    } else {
      setPlace({ left, top: below });
    }
  }, [session, state]);

  // What did not fit on a row (a long command, its words cut short) is shown in
  // full under it while it is chosen or pointed at.
  const [hovered, setHovered] = useState(-1);
  const [cut, setCut] = useState<ReadonlyMap<number, { command: boolean; detail: boolean }>>(new Map());
  useLayoutEffect(() => {
    const rows = ref.current?.querySelectorAll<HTMLElement>(".suggest-item");
    const found = new Map<number, { command: boolean; detail: boolean }>();
    const short = (part: HTMLElement | null) => !!part && part.scrollWidth > part.clientWidth + 1;
    rows?.forEach((row, index) => {
      const command = short(row.querySelector(".suggest-text")) || short(row.querySelector(".suggest-args"));
      const detail = short(row.querySelector(".suggest-detail"));
      if (command || detail) found.set(index, { command, detail });
    });
    setCut(found);
  }, [state?.items]);

  // The list scrolls; the row chosen with the arrows stays in sight.
  useEffect(() => {
    ref.current?.querySelector(".suggest-item.active")?.scrollIntoView({ block: "nearest" });
  }, [state?.index]);

  if (!session || !state) return null;
  const firstFix = state.items.findIndex((item) => item.kind === "fix");

  return (
    <div ref={ref} className="suggest" style={place} role="listbox">
      <div className="suggest-list">
        {state.items.map((item, index) => {
          const Icon = item.kind === "path" && !item.label.endsWith("/") ? File : SUGGEST_ICONS[item.kind];
          const match = item.match ?? 0;
          return (
            <Fragment key={`${item.kind}:${item.label}`}>
              {index === firstFix && <div className="suggest-title">{t("suggest.did_you_mean")}</div>}
              <div
                role="option"
                aria-selected={index === state.index}
                className={cx("suggest-item", item.kind, item.danger && "danger", index === state.index && "active")}
                // Each row says what it is by its icon; a tooltip over the list only covers
                // the rows under it. Only a warning is worth one.
                title={item.danger ? t("suggest.ai_danger") : undefined}
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered((was) => (was === index ? -1 : was))}
                // Keep the terminal focused: act on press, not on click.
                onMouseDown={(e) => {
                  e.preventDefault();
                  session.suggester.accept(index);
                }}
              >
                <div className="suggest-line">
                  <Icon size={13} className="suggest-icon" />
                  <span className="suggest-text">
                    {match > 0 && <mark className="suggest-typed">{item.label.slice(0, match)}</mark>}
                    {item.label.slice(match)}
                  </span>
                  {item.args && <span className="suggest-args">{item.args}</span>}
                  {item.detail && <span className="suggest-detail">{item.detail}</span>}
                </div>
                {cut.has(index) && (index === state.index || index === hovered) && (
                  <div className="suggest-full">
                    {cut.get(index)?.command && (
                      <code>
                        {item.label}
                        {item.args && ` ${item.args}`}
                      </code>
                    )}
                    {item.detail && <span>{item.detail}</span>}
                  </div>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
      {state.note && (
        <div className="suggest-note">
          {state.note === t("suggest.ai_thinking") ? (
            <span className="spinner" />
          ) : (
            <WandSparkles size={13} className="suggest-icon" />
          )}
          {state.note}
        </div>
      )}
      {state.items.length > 0 && (
        <div className="suggest-hint">
          {state.items.length === 1 && state.items[0].kind === "ask" ? t("suggest.hint_ask") : t("suggest.hint")}
        </div>
      )}
    </div>
  );
}

/** How long "Done" stays up after a snippet has finished. */
const DONE_SHOWN_MS = 2400;

/**
 * A snippet sent to this terminal has finished (its prompt is back): a tick
 * pops up at the top of the terminal for a moment, and goes.
 */
function RunDone({ state }: { state: Tab["runState"] }) {
  const t = useT();
  const [shown, setShown] = useState(0);
  const was = useRef(state);
  useEffect(() => {
    if (state === "done" && was.current === "running") {
      setShown((n) => n + 1);
      const timer = window.setTimeout(() => setShown(0), DONE_SHOWN_MS);
      was.current = state;
      return () => window.clearTimeout(timer);
    }
    was.current = state;
  }, [state]);
  if (!shown) return null;
  return (
    <div key={shown} className="run-done" role="status">
      <span className="run-tick">
        <Check size={12} strokeWidth={3} />
      </span>
      {t("run.done")}
    </div>
  );
}

/** The strip under a terminal whose session is not running. */
function ClosedBar({ tab }: { tab: Tab }) {
  const t = useT();
  const session = getSession(tab.id);
  const hostExists = useVault((s) => s.snapshot.hosts.some((h) => h.id === tab.hostId));
  const closed = tab.closed;
  if (!closed || !session) return null;

  const title =
    closed.reason === "exited"
      ? closed.exit_status
        ? t("term.closed.exited.status", { status: closed.exit_status })
        : t("term.closed.exited")
      : closed.reason === "user"
        ? t("term.closed.cancelled")
        : closed.reason === "lost"
          ? t("term.closed.lost")
          : t("term.closed.failed");

  let detail: React.ReactNode = t("term.enter_hint");
  if (!hostExists) detail = t("term.host_missing");
  else if (tab.reconnect?.network) detail = t("term.reconnect.network");
  else if (tab.reconnect) detail = <Countdown at={tab.reconnect.at} attempt={tab.reconnect.attempt} />;
  else if (tab.gaveUp) detail = t("term.reconnect.gave_up", { n: tab.gaveUp });
  else if (closed.error) {
    const text = errorText(closed.error);
    detail = closed.error.detail ? `${text} — ${closed.error.detail}` : text;
  }

  const editHost = () => {
    const ui = useUi.getState();
    ui.setHostPanel({ mode: "edit", hostId: tab.hostId, tabId: tab.id });
    ui.goHome("hosts");
  };

  return (
    <div className={cx("term-bar", closed.reason === "failed" ? "error" : closed.reason === "lost" && "warn")}>
      <div className="text">
        <div className="title">{title}</div>
        <div className="detail selectable" title={typeof detail === "string" ? detail : undefined}>
          {detail}
        </div>
      </div>
      {tab.reconnect && (
        <button className="btn small" onClick={() => session.stopReconnecting()}>
          {t("term.reconnect.stop")}
        </button>
      )}
      {hostExists && closed.reason === "failed" && (
        <button className="btn small" onClick={editHost}>
          {t("term.edit_host")}
        </button>
      )}
      {hostExists && (
        <button className="btn small primary" onClick={() => session.reconnect()}>
          {t("term.reconnect")}
        </button>
      )}
      <button className="btn small" onClick={() => closeTab(tab.id)}>
        {t("common.close")}
      </button>
    </div>
  );
}

/** A path as a shell takes it in one piece: quoted when it has to be. */
function quotePath(path: string): string {
  if ((WINDOWS ? /^[\w@%+=:,./\\-]+$/ : /^[\w@%+=:,./-]+$/).test(path)) return path;
  return WINDOWS ? `"${path}"` : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Files dragged from the system onto a terminal: a server's uploads them
 * into the folder the shell is in, through the file manager, which opens
 * there to show them arrive; this computer's types their paths, as the
 * Mac's own Terminal does.
 */
async function dropOnTerminal(tab: Tab, session: TermSession, paths: string[]) {
  if (isLocalTab(tab)) {
    session.insert(`${paths.map(quotePath).join(" ")} `);
    return;
  }
  const dir = await session.workingDirectory();
  useUi.getState().patchTab(tab.id, { files: true, filesDrop: { paths, dir } });
}

export function TerminalPane({ tab, active }: { tab: Tab; active: boolean }) {
  const t = useT();
  const session = getSession(tab.id);
  const hostRef = useRef<HTMLDivElement>(null);
  const address = useVault((s) => s.snapshot.hosts.find((h) => h.id === tab.hostId)?.address ?? tab.title);
  const background = useSettings(
    (s) => resolveTermTheme(s.termTheme, isDark(s.theme)).colors.background,
  );
  const share = useShare((s) => s.shares[tab.id]);
  const account = useVault((s) => s.snapshot.cloud?.email ?? "");
  const serverStats = useSettings((s) => s.serverStats && s.statsBar);

  // Attach once the terminal font is ready, so the cell grid is measured
  // with the right metrics; then follow the element's size.
  useEffect(() => {
    const element = hostRef.current;
    if (!session || !element) return;
    let cancelled = false;
    const settings = useSettings.getState();
    void document.fonts
      .load(`${settings.fontSize}px "${settings.fontFamily}"`)
      .catch(() => {})
      .then(() => {
        if (!cancelled) session.mount(element);
      });
    const observer = new ResizeObserver(() => session.refit());
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [session]);

  // Until the first session works, and the screen has faded away after it,
  // the pane shows the connection itself.
  // A terminal on this computer has no connection to show, only a short start of its own.
  const [connectScreen, setConnectScreen] = useState(!isLocalTab(tab));
  const [localIntro, setLocalIntro] = useState(isLocalTab(tab));
  const leaveLocalIntro = useCallback(() => setLocalIntro(false), []);
  const leaveConnectScreen = useCallback(() => setConnectScreen(false), []);
  const blocked =
    connectScreen ||
    tab.prompt !== null ||
    tab.searchOpen ||
    tab.side !== null ||
    tab.files ||
    tab.editor !== null;
  useEffect(() => {
    if (active && session && !blocked) {
      session.refit();
      session.focus();
    }
  }, [active, session, blocked, tab.status]);

  const dropKey = `term:${tab.id}`;
  const dropping = useDrag((s) => s.over === dropKey);

  if (!session) return null;
  // With guests in the session, the cursor says whose turn at the keyboard it is.
  const typist =
    share && share.guests.some((guest) => guest.name)
      ? share.control === 0
        ? { name: account || share.hostName, tone: personTone(0) }
        : {
            name: share.guests.find((guest) => guest.id === share.control)?.name ?? "",
            tone: personTone(share.control),
          }
      : null;

  return (
    <div className={cx("term-pane", !active && "hidden")} style={{ background }} aria-hidden={!active}>
      <RunDone state={tab.runState ?? null} />
      <ShareBar tab={tab} />
      <div className="term-main">
        <div
          className={cx("term-wrap", dropping && "file-over")}
          ref={dropTarget({
            key: dropKey,
            accepts: (payload) =>
              payload.kind === "files" && tab.status === "connected" && !tab.files && !tab.editor && !connectScreen,
            drop: (payload) => void dropOnTerminal(tab, session, payload.paths ?? []),
          })}
        >
          <div className="term-host" ref={hostRef} onContextMenu={(e) => e.preventDefault()} />
          {dropping && (
            <div className="term-drop">
              {t(isLocalTab(tab) ? "term.drop.paths" : "term.drop.upload")}
            </div>
          )}
          {tab.suggest && active && <SuggestGhost tab={tab} />}
          {tab.suggest && active && <SuggestList tab={tab} />}
          {tab.passwordOffer && active && !tab.suggest && <PasswordOffer tab={tab} />}
          {tab.passwordSave && <PasswordSave key={JSON.stringify(tab.passwordSave)} tab={tab} />}
          {typist && <CursorBadge term={session.term} name={typist.name} tone={typist.tone} />}
        </div>
        {tab.side === "snippets" && <SnippetsPanel tab={tab} />}
        {tab.files && <FileManager tab={tab} />}
        {tab.editor && <FileEditor key={tab.editor.path} tab={tab} />}
      </div>
      {serverStats && tab.status === "connected" && !isLocalTab(tab) && <LiveStats tab={tab} active={active} />}

      {tab.searchOpen && <SearchBox tab={tab} />}

      {active && !isLocalTab(tab) && tab.status === "connected" && !tab.files && !tab.editor && (
        <Tip id="terminal" title={t("tip.terminal.title")} className="tip-float" art={MOBILE ? undefined : <TypingDemo />}>
          {t("tip.terminal.text", { files: keyOf("files"), snippets: keyOf("snippets"), find: keyOf("find") })}
        </Tip>
      )}

      {connectScreen && <ConnectScreen tab={tab} active={active} onDone={leaveConnectScreen} />}
      {localIntro && <LocalIntro tab={tab} onDone={leaveLocalIntro} />}

      {!connectScreen && !isLocalTab(tab) && tab.status === "connecting" && !tab.prompt && (
        <div className="term-connecting">
          <span className="spinner" />
          <span className="label">
            {t(`term.stage.${tab.stage ?? "connecting"}` as MessageKey, { host: address })}
          </span>
          <button className="btn small" onClick={() => session.cancelConnecting()}>
            {t("term.cancel")}
          </button>
        </div>
      )}

      {!connectScreen && tab.status === "closed" && !tab.reconnect && <FailedAttempt tab={tab} />}
      {!connectScreen && tab.status === "closed" && <ClosedBar tab={tab} />}

      {active && <ExternalConflict tab={tab} />}

      {tab.prompt && active && (
        <PromptDialog
          key={tab.prompt.id}
          prompt={tab.prompt.prompt}
          onReply={(reply) => {
            session.reply(reply);
            // Behind the connection screen the terminal must not take the keys.
            if (!connectScreen) session.focus();
          }}
        />
      )}
    </div>
  );
}
