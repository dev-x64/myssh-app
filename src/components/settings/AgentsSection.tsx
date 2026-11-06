import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { agentInfo } from "../../lib/agents";
import { useT } from "../../lib/i18n";
import { WINDOWS } from "../../lib/platform";
import { useSettings } from "../../lib/settings";
import { Segmented, Switch } from "../ui";
import { AgentClients, CopyBlock } from "../terminal/AgentPanel";

type Agent = "claude" | "codex" | "other";

/**
 * Coding agents at the terminals: off until turned on here, and then how
 * to go about it, step by step: connect the agent once, open a tab to it,
 * ask it for something.
 */
export function AgentsSection() {
  const t = useT();
  const on = useSettings((s) => s.agents);
  const [program, setProgram] = useState<string | null>(null);
  const [agent, setAgent] = useState<Agent>("claude");

  useEffect(() => {
    if (!on) return;
    void agentInfo()
      .then((info) => setProgram(info.program))
      .catch(() => {});
  }, [on]);

  const quoted = program ? (/\s/.test(program) || WINDOWS ? `"${program}"` : program) : "";
  const setup: Record<Agent, string> = {
    claude: `claude mcp add --scope user myssh -- ${quoted} mcp`,
    codex: `codex mcp add myssh -- ${quoted} mcp`,
    other: JSON.stringify({ mcpServers: { myssh: { command: program, args: ["mcp"] } } }, null, 2),
  };

  return (
    <>
      <div className="section-title" id="settings-agents">
        {t("settings.agents")}
      </div>
      <div className="table">
        <div className="setting">
          <div className="setting-text">
            <div className="name">{t("settings.agents.enable")}</div>
            <div className="hint">{t(on ? "settings.agents.hint.on" : "settings.agents.hint")}</div>
          </div>
          <div className="control">
            <Switch on={on} onChange={(agents) => useSettings.getState().set({ agents })} />
          </div>
        </div>

        {on && (
          <div className="setting">
            <div className="setting-text">
              <div className="name">{t("agents.connected")}</div>
              <AgentClients />
            </div>
          </div>
        )}

        {on && program && (
          <div className="setting agents-guide-row">
            <ol className="agents-guide">
              <li>
                <div className="agents-step-title">{t("settings.agents.step1")}</div>
                <p>{t(`settings.agents.step1.${agent}`)}</p>
                <Segmented<Agent>
                  value={agent}
                  options={[
                    { value: "claude", label: "Claude Code" },
                    { value: "codex", label: "Codex" },
                    { value: "other", label: t("settings.agents.other") },
                  ]}
                  onChange={setAgent}
                />
                <CopyBlock text={setup[agent]} />
                <p className="dim">{t(agent === "other" ? "settings.agents.step1.other.after" : "settings.agents.step1.after")}</p>
              </li>
              <li>
                <div className="agents-step-title">{t("settings.agents.step2")}</div>
                <p>
                  {t("settings.agents.step2.text.before")}{" "}
                  <span className="agents-inline-icon">
                    <Bot size={13} />
                  </span>{" "}
                  {t("settings.agents.step2.text.after")}
                </p>
              </li>
              <li>
                <div className="agents-step-title">{t("settings.agents.step3")}</div>
                <p>{t("settings.agents.step3.text")}</p>
                <div className="agents-example">{t("settings.agents.step3.example")}</div>
              </li>
            </ol>
            <p className="agents-footnote">{t("settings.agents.note")}</p>
          </div>
        )}
      </div>
    </>
  );
}
