import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Bot, Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { agentName, useAgents, type AgentAccess } from "../../lib/agents";
import { useT } from "../../lib/i18n";
import { useUi, type Tab } from "../../lib/store";
import { cx, Segmented } from "../ui";

/** Text to paste somewhere (a command, a config), and a button that copies it. */
export function CopyBlock({ label, text }: { label?: string; text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="agents-cmd">
      {label && <span className="agents-cmd-label">{label}</span>}
      <div className="agents-cmd-line">
        <code className="selectable">{text}</code>
        <button
          className={cx("btn small", copied && "done")}
          onClick={() => void writeText(text).then(() => setCopied(true)).catch(() => {})}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {t(copied ? "agents.copied" : "agents.copy")}
        </button>
      </div>
    </div>
  );
}

/**
 * The agents connected now, by name. An agent connects once for each of
 * its chats or sessions; those of one agent are shown together, counted.
 */
export function AgentClients() {
  const t = useT();
  const clients = useAgents((s) => s.clients);
  if (clients.length === 0) return <p className="dim">{t("agents.none")}</p>;
  const counted = new Map<string, number>();
  for (const client of clients) {
    const name = agentName(client);
    counted.set(name, (counted.get(name) ?? 0) + 1);
  }
  return (
    <div className="agents-clients">
      {[...counted].map(([name, n]) => (
        <span key={name} className="chip" title={t("agents.sessions", { n })}>
          <Bot size={12} />
          {name}
          {n > 1 && <span className="agents-times">×{n}</span>}
        </span>
      ))}
    </div>
  );
}

/** Opens Settings at the agents' section, with its instructions. */
export function showAgentSettings() {
  useUi.getState().goHome("settings");
  // The page is drawn on the next render; the section is then brought into view.
  window.setTimeout(() => document.getElementById("settings-agents")?.scrollIntoView({ block: "start" }), 60);
}

/**
 * The button in the title bar that opens the active terminal to coding
 * agents, and its panel: how far they may go here, and which ones are
 * connected. How to connect one is told in Settings.
 */
export function AgentButton({ tab }: { tab: Tab }) {
  const t = useT();
  const access = useAgents((s) => s.access[tab.id] ?? null);
  const setAccess = useAgents((s) => s.setAccess);
  const count = useAgents((s) => s.clients.length);
  const connected = count > 0;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="share" ref={root}>
      <button
        className={cx("btn ghost icon small", (open || access) && "on")}
        title={access ? t(access === "control" ? "agents.on.control" : "agents.on.read") : t("agents.button")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Bot size={15} />
        {connected && <span className="share-count">{count}</span>}
      </button>

      {open && (
        <div className="share-panel agents-panel" role="dialog" aria-label={t("agents.title")}>
          <div className="share-head">
            <Bot size={15} />
            <span className="grow">{t("agents.title")}</span>
          </div>
          <div className="share-body">
            <span className="share-label">{t("agents.access")}</span>
            <Segmented<AgentAccess | "off">
              value={access ?? "off"}
              options={[
                { value: "off", label: t("agents.access.off") },
                { value: "read", label: t("agents.access.read") },
                { value: "control", label: t("agents.access.control") },
              ]}
              onChange={(value) => setAccess(tab.id, value === "off" ? null : value)}
            />
            {access === null ? (
              <div className="agents-explain">
                <p>{t("agents.access.off.hint")}</p>
                <ul>
                  <li>
                    <b>{t("agents.access.read")}</b> — {t("agents.access.off.read")}
                  </li>
                  <li>
                    <b>{t("agents.access.control")}</b> — {t("agents.access.off.control")}
                  </li>
                </ul>
                {!connected && <p>{t("agents.access.off.first")}</p>}
              </div>
            ) : (
              <p className={cx("agents-brief", access === "control" && "warn")}>
                {t(access === "control" ? "agents.warn" : "agents.access.read.hint")}
              </p>
            )}

            <span className="share-label">{t("agents.connected")}</span>
            <AgentClients />
            <button
              className={cx("btn small", !connected && "primary")}
              onClick={() => {
                setOpen(false);
                showAgentSettings();
              }}
            >
              {t(connected ? "agents.settings" : "agents.how")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** On a tab open to agents: a robot, which wakes while an agent is at work there. */
export function AgentMark({ tabId }: { tabId: string }) {
  const t = useT();
  const access = useAgents((s) => s.access[tabId] ?? null);
  const touched = useAgents((s) => s.touched[tabId] ?? 0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!touched) return;
    setBusy(true);
    const timer = window.setTimeout(() => setBusy(false), 2500);
    return () => window.clearTimeout(timer);
  }, [touched]);
  if (!access) return null;
  return (
    <span
      className={cx("agents-mark", busy && "busy")}
      title={t(access === "control" ? "agents.on.control" : "agents.on.read")}
    >
      <Bot size={12} />
    </span>
  );
}
