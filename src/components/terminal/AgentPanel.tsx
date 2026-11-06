import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Bot, Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { agentInfo, agentName, useAgents, type AgentAccess } from "../../lib/agents";
import { useT } from "../../lib/i18n";
import { WINDOWS } from "../../lib/platform";
import { type Tab } from "../../lib/store";
import { cx, Segmented } from "../ui";

/** A command line to paste into a terminal, and a button that copies it. */
function CommandLine({ label, command }: { label: string; command: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="agents-cmd">
      <span className="agents-cmd-label">{label}</span>
      <div className="agents-cmd-line">
        <code className="selectable">{command}</code>
        <button
          className={cx("btn ghost icon small", copied && "done")}
          title={t("agents.copy")}
          onClick={() => void writeText(command).then(() => setCopied(true)).catch(() => {})}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}

/**
 * The button in the title bar that opens the active terminal to coding
 * agents, and its panel: how far they may go, which ones are connected,
 * and how to connect one.
 */
export function AgentButton({ tab }: { tab: Tab }) {
  const t = useT();
  const access = useAgents((s) => s.access[tab.id] ?? null);
  const setAccess = useAgents((s) => s.setAccess);
  const clients = useAgents((s) => s.clients);
  const [open, setOpen] = useState(false);
  const [program, setProgram] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void agentInfo()
      .then((info) => {
        setProgram(info.program);
        useAgents.setState({ clients: info.clients });
      })
      .catch(() => {});
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

  const quoted = program ? (/\s/.test(program) || WINDOWS ? `"${program}"` : program) : "";

  return (
    <div className="share" ref={root}>
      <button
        className={cx("btn ghost icon small", (open || access) && "on")}
        title={access ? t(access === "control" ? "agents.on.control" : "agents.on.read") : t("agents.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Bot size={15} />
      </button>

      {open && (
        <div className="share-panel agents-panel" role="dialog" aria-label={t("agents.title")}>
          <div className="share-head">
            <Bot size={15} />
            <span className="grow">{t("agents.title")}</span>
          </div>
          <div className="share-body">
            <p>{t("agents.intro")}</p>
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
            {access === "control" && <p className="note warn">{t("agents.warn")}</p>}

            <span className="share-label">{t("agents.connected")}</span>
            {clients.length === 0 ? (
              <p className="dim">{t("agents.none")}</p>
            ) : (
              <div className="agents-clients">
                {clients.map((client, index) => (
                  <span key={`${client}-${index}`} className="chip">
                    <Bot size={12} />
                    {agentName(client)}
                  </span>
                ))}
              </div>
            )}

            <span className="share-label">{t("agents.how")}</span>
            <p>{t("agents.how.text")}</p>
            {program && (
              <>
                <CommandLine label="Claude Code" command={`claude mcp add --scope user myssh -- ${quoted} mcp`} />
                <CommandLine label="Codex" command={`codex mcp add myssh -- ${quoted} mcp`} />
              </>
            )}
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
