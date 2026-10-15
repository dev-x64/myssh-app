import {
  Cable,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Fingerprint,
  KeyRound,
  Minus,
  SquareTerminal,
  X,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useRef, useState } from "react";
import type { HostView, LogEntry } from "../../lib/api";
import { errorText, useT } from "../../lib/i18n";
import { closeTab, getSession } from "../../lib/sessions";
import { hostSubtitle, useUi, useVault, type LogLine, type Tab } from "../../lib/store";
import { OsIcon } from "../hosts/OsIcon";
import { cx } from "../ui";

type T = ReturnType<typeof useT>;

/**
 * The track never jumps: it takes one step at a time, this far apart, even
 * when the server answers at once. After the last step the screen rests for
 * a moment and then fades away over the terminal.
 */
const STEP_MS = 280;
const REST_MS = 240;
const LEAVE_MS = 380;

/** What the app is doing while each step of the track is in progress. */
const STAGES = ["connecting", "handshake", "authenticating", "opening_shell"] as const;

const STEPS = [
  { name: "conn.step.network", icon: Cable },
  { name: "conn.step.host_key", icon: Fingerprint },
  { name: "conn.step.auth", icon: KeyRound },
  { name: "conn.step.shell", icon: SquareTerminal },
] as const;

/** How many steps the attempt has completed, going by its log. */
function completed(log: LogLine[]): number {
  let done = 0;
  for (const { entry } of log) {
    if (entry.code === "reached") done = Math.max(done, 1);
    else if (entry.code === "host_key" && entry.status === "trusted") done = Math.max(done, 2);
    else if (entry.code === "host_key_accepted") done = Math.max(done, 2);
    else if (entry.code === "auth_accepted" || entry.code === "auth_not_required") done = Math.max(done, 3);
    else if (entry.code === "shell_ready") done = 4;
  }
  return done;
}

function method(t: T, name: string): string {
  const key = `log.method.${name}`;
  return key === "log.method.publickey" || key === "log.method.password" || key === "log.method.keyboard-interactive"
    ? t(key)
    : name;
}

function methods(t: T, names: string[]): string {
  return names.map((name) => method(t, name)).join(", ");
}

/** A log entry in words, and whether it is good or bad news. */
function describe(t: T, entry: LogEntry): { text: string; tone?: "ok" | "bad" | "wait" } {
  switch (entry.code) {
    case "connecting":
      return { text: t("log.connecting", { host: entry.host, port: entry.port }) };
    case "reached":
      return { text: t("log.reached", { address: entry.address }), tone: "ok" };
    case "host_key":
      return {
        text: t(`log.host_key.${entry.status}`, {
          algorithm: entry.algorithm,
          fingerprint: entry.fingerprint,
        }),
        tone: entry.status === "changed" ? "bad" : entry.status === "trusted" ? "ok" : undefined,
      };
    case "host_key_accepted":
      return { text: t("log.host_key_accepted"), tone: "ok" };
    case "auth_offered":
      return { text: t("log.auth_offered", { methods: methods(t, entry.methods) }) };
    case "auth_not_required":
      return { text: t("log.auth_not_required"), tone: "ok" };
    case "auth_unavailable":
      return {
        text: t(entry.method === "publickey" ? "log.auth_unavailable.publickey" : "log.auth_unavailable.password"),
        tone: "bad",
      };
    case "auth_trying":
      if (entry.method === "publickey") return { text: t("log.try.publickey", { detail: entry.detail ?? "" }) };
      if (entry.method === "password") {
        return { text: t(entry.saved ? "log.try.password.saved" : "log.try.password.typed") };
      }
      return {
        text: t(entry.saved ? "log.try.keyboard-interactive.saved" : "log.try.keyboard-interactive.typed"),
      };
    case "auth_accepted":
      return { text: t("log.accepted", { method: method(t, entry.method) }), tone: "ok" };
    case "auth_rejected":
      if (entry.partial) {
        return {
          text: t("log.partial", { method: method(t, entry.method), methods: methods(t, entry.remaining) }),
        };
      }
      return {
        text: entry.remaining.length
          ? t("log.rejected.remaining", {
              method: method(t, entry.method),
              methods: methods(t, entry.remaining),
            })
          : t("log.rejected", { method: method(t, entry.method) }),
        tone: "bad",
      };
    case "waiting":
      return { text: t(`log.waiting.${entry.what}`), tone: "wait" };
    case "shell_opening":
      return { text: t("log.shell_opening") };
    case "shell_ready":
      return { text: t("log.shell_ready"), tone: "ok" };
  }
}

/** What to check, going by how far the attempt got and how it ended. */
function advice(t: T, tab: Tab, host: HostView | undefined): string | null {
  const closed = tab.closed;
  if (!closed || closed.reason === "user" || closed.reason === "exited") return null;
  const code = closed.error?.code;
  const detail = (closed.error?.detail ?? "").toLowerCase();
  const entries = tab.log.map((line) => line.entry);
  // What was actually dialled, which a later edit of the host may not match.
  const dialled = entries.find((e) => e.code === "connecting");
  const port = dialled?.code === "connecting" ? dialled.port : (host?.port ?? 22);
  const address = dialled?.code === "connecting" ? dialled.host : (host?.address ?? "");

  if (code === "host_key_rejected") return t("hint.host_key");
  if (code === "key" || code === "key_encrypted") return t("hint.key");
  if (code === "auth_failed") {
    const offered = entries.find((e) => e.code === "auth_offered");
    const tried = entries.some((e) => e.code === "auth_trying");
    return !tried && offered?.code === "auth_offered"
      ? t("hint.auth.nothing", { methods: methods(t, offered.methods) })
      : t("hint.auth");
  }
  if (!entries.some((e) => e.code === "reached")) {
    if (detail.includes("refused")) return t("hint.refused", { port });
    if (/lookup|nodename|not known|resolve/.test(detail)) return t("hint.dns", { host: address });
    if (/no route|unreachable|network is down/.test(detail)) return t("hint.unreachable");
    if (code === "timeout" || detail.includes("timed out")) return t("hint.timeout");
    return null;
  }
  if (!entries.some((e) => e.code === "host_key")) return t("hint.no_ssh", { port });
  if (completed(tab.log) === 2) return t("hint.dropped");
  return null;
}

function stamp(line: number, first: number): string {
  return `+${((line - first) / 1000).toFixed(2)}`;
}

interface Line {
  time: string;
  text: string;
  tone?: "ok" | "bad" | "wait";
}

/** The attempt as lines of text, ending with how it ended. */
function attemptLines(t: T, tab: Tab): { lines: Line[]; reason: string | null } {
  const closed = tab.closed;
  const first = tab.log[0]?.at ?? closed?.at ?? 0;
  const lines: Line[] = tab.log.map((line) => ({ time: stamp(line.at, first), ...describe(t, line.entry) }));
  if (!closed) return { lines, reason: null };
  const title =
    closed.reason === "user"
      ? t("term.closed.cancelled")
      : closed.reason === "lost" && !closed.error
        ? t("conn.lost")
        : closed.error
          ? errorText(closed.error)
          : t("term.closed.failed");
  const reason = closed.error?.detail ? `${title} — ${closed.error.detail}` : title;
  lines.push({ time: stamp(closed.at, first), text: reason, tone: closed.reason === "user" ? undefined : "bad" });
  return { lines, reason };
}

function LogLines({ lines }: { lines: Line[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);
  return (
    <div className="connect-log scroll selectable" ref={ref}>
      {lines.map((line, index) => (
        <div key={index} className={cx("log-line", line.tone)}>
          <span className="log-time">{line.time}</span>
          <span>{line.text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Why a reconnection did not work, for a tab that keeps its terminal: the
 * same log and advice as on the connection screen, above the closed bar.
 */
export function FailedAttempt({ tab }: { tab: Tab }) {
  const t = useT();
  const host = useVault((s) => s.snapshot.hosts.find((h) => h.id === tab.hostId));
  if (tab.closed?.reason !== "failed" || tab.log.length === 0) return null;
  const hint = advice(t, tab, host);
  return (
    <div className="term-attempt">
      <LogLines lines={attemptLines(t, tab).lines} />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/**
 * The connection in progress, or the one that failed: the host, how far it
 * got, and a log that says what was tried and what the server answered.
 */
export function ConnectScreen(props: {
  tab: Tab;
  active: boolean;
  /** The session works and the screen has finished leaving. */
  onDone: () => void;
}) {
  const { tab, active } = props;
  const t = useT();
  const session = getSession(tab.id);
  const snapshot = useVault((s) => s.snapshot);
  const host = snapshot.hosts.find((h) => h.id === tab.hostId);
  const [chosen, setChosen] = useState<boolean | null>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  // Once a session has worked, whatever happens to it later is not ours to show.
  const closed = tab.everConnected ? null : tab.closed;
  const failed = closed !== null && closed.reason !== "user";
  // The track follows the real progress one step at a time.
  const reached = tab.everConnected ? STEPS.length : completed(tab.log);
  const [done, setDone] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const steppedAt = useRef(Date.now());
  useEffect(() => {
    if (done === reached) return;
    // A new attempt starts from the beginning.
    if (done > reached) return setDone(reached);
    // Steps are kept apart, but a server that takes its time is not made to
    // look slower still.
    const wait = Math.max(0, steppedAt.current + STEP_MS - Date.now());
    const timer = window.setTimeout(() => {
      steppedAt.current = Date.now();
      setDone((n) => n + 1);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [done, reached]);
  const { onDone } = props;
  useEffect(() => {
    if (!tab.everConnected || done < STEPS.length) return;
    const rest = window.setTimeout(() => setLeaving(true), REST_MS);
    const leave = window.setTimeout(onDone, REST_MS + LEAVE_MS);
    return () => {
      window.clearTimeout(rest);
      window.clearTimeout(leave);
    };
  }, [tab.everConnected, done, onDone]);
  // How an attempt ended shows once the track has caught up with it.
  const settled = done === reached;

  // The log opens by itself whenever an attempt ends without a session,
  // every time: hiding it once does not hide the next failure.
  const logShown = chosen ?? (closed !== null && settled);
  useEffect(() => {
    if (closed) setChosen(null);
  }, [closed]);

  useEffect(() => {
    if (closed && active && !tab.prompt) retryRef.current?.focus();
  }, [closed, active, tab.prompt]);

  if (!session) return null;

  const { lines, reason } = attemptLines(t, tab);
  const hint = advice(t, tab, host);

  const editHost = () => {
    const ui = useUi.getState();
    ui.setHostPanel({ mode: "edit", hostId: tab.hostId, tabId: tab.id });
    ui.goHome("hosts");
  };
  const copyLog = async () => {
    await writeText(lines.map((line) => `${line.time}  ${line.text}`).join("\n"));
    useUi.getState().toast("success", t("conn.log.copied"));
  };

  return (
    <div className={cx("connect scroll", leaving && "leaving")}>
      <div className={cx("connect-card", failed && "failed")}>
        <div className="connect-host">
          <span className="card-icon">
            <OsIcon os={host?.os ?? null} />
          </span>
          <div className="grow">
            <div className="connect-title">{tab.title}</div>
            <div className="connect-sub selectable">SSH · {host ? hostSubtitle(host, snapshot) : "—"}</div>
          </div>
        </div>

        <ol className="track">
          {STEPS.map((step, index) => {
            const state =
              index < done
                ? "done"
                : index > done
                  ? "pending"
                  : !closed || !settled
                    ? "active"
                    : failed
                      ? "failed"
                      : "stopped";
            const Icon = step.icon;
            return (
              <li key={step.name} className={cx("step", state)}>
                <span className="node">
                  {state === "done" ? (
                    <Check size={14} strokeWidth={3} />
                  ) : state === "failed" ? (
                    <X size={14} strokeWidth={3} />
                  ) : state === "stopped" ? (
                    <Minus size={14} strokeWidth={3} />
                  ) : state === "active" && !tab.prompt ? (
                    <span className="spinner" />
                  ) : (
                    <Icon size={13} />
                  )}
                </span>
                <span className="step-name">{t(step.name)}</span>
              </li>
            );
          })}
        </ol>

        <div className={cx("connect-status", failed && "error")} role="status">
          {done === STEPS.length ? (
            <div className="title" key="ready">
              {t("conn.ready")}
            </div>
          ) : closed && settled ? (
            <>
              <div className="title" key="closed">
                {closed.reason === "user" ? t("term.closed.cancelled") : t("term.closed.failed")}
              </div>
              {failed && <div className="reason selectable">{reason}</div>}
              {hint && <div className="hint">{hint}</div>}
            </>
          ) : (
            // The words follow the track, not the wire.
            <div className="title" key={tab.prompt && settled ? "waiting" : done}>
              {tab.prompt && settled
                ? t("conn.waiting")
                : t(`term.stage.${STAGES[done]}`, { host: host?.address ?? tab.title })}
            </div>
          )}
        </div>

        {logShown && <LogLines lines={lines} />}

        <div className="connect-actions">
          <button type="button" className="btn ghost small" onClick={() => setChosen(!logShown)}>
            {logShown ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {t(logShown ? "conn.log.hide" : "conn.log.show")}
          </button>
          {logShown && lines.length > 0 && (
            <button
              type="button"
              className="btn ghost small icon"
              title={t("conn.log.copy")}
              onClick={() => void copyLog()}
            >
              <Copy size={13} />
            </button>
          )}
          <div className="grow" />
          {tab.everConnected ? null : !closed ? (
            <button type="button" className="btn" onClick={() => session.cancelConnecting()}>
              {t("term.cancel")}
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => closeTab(tab.id)}>
                {t("common.close")}
              </button>
              {host && (
                <button type="button" className="btn" onClick={editHost}>
                  {t("term.edit_host")}
                </button>
              )}
              {host && (
                <button type="button" className="btn primary" ref={retryRef} onClick={() => session.reconnect()}>
                  {t("conn.retry")}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
