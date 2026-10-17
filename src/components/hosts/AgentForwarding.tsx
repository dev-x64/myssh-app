import { BadgeCheck, GitBranch, KeyRound, Laptop, Server, ShieldAlert } from "lucide-react";
import { useState } from "react";
import type { KeyView } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { cx, Segmented, Switch } from "../ui";

type Example = "git" | "ssh";

/**
 * Agent forwarding on a host, said so a newcomer gets it at a glance: what
 * it lets the server do, drawn as it happens (the server asks, this Mac
 * signs, the signature goes back, the server is let in), on an example to
 * pick, with the keys the server will see and when not to turn it on.
 */
export function AgentForwarding(props: {
  on: boolean;
  onChange: (on: boolean) => void;
  hostName: string;
  keys: KeyView[];
}) {
  const t = useT();
  const [example, setExample] = useState<Example>("git");
  // Opened by itself for a host that has it on, and the first time it is turned on.
  const [open, setOpen] = useState(props.on);
  const server = props.hostName.trim() || t("agent.server");
  // A key whose passphrase is not saved cannot be used without asking: it stays out.
  const usable = props.keys.filter((key) => !key.encrypted || key.has_passphrase);
  const left = props.keys.filter((key) => key.encrypted && !key.has_passphrase);

  return (
    <div className={cx("group-box agent-box", props.on && "on")}>
      <div className="row" style={{ alignItems: "center" }}>
        <span className="field-label grow">
          <KeyRound size={14} />
          {t("agent.title")}
        </span>
        <Switch
          on={props.on}
          label={t("agent.title")}
          onChange={(on) => {
            props.onChange(on);
            if (on) setOpen(true);
          }}
        />
      </div>
      <p className="agent-lead">{t("agent.lead")}</p>

      {!open ? (
        <button type="button" className="link-button agent-more" onClick={() => setOpen(true)}>
          {t("agent.how")}
        </button>
      ) : (
        <>
          <Segmented
            value={example}
            onChange={setExample}
            options={[
              { value: "git", label: t("agent.ex.git") },
              { value: "ssh", label: t("agent.ex.ssh") },
            ]}
          />
          <AgentDemo key={example} example={example} server={server} />
          {props.on && (
            <div className="agent-keys">
              <div className="agent-keys-title">{t("agent.keys")}</div>
              {usable.length === 0 ? (
                <p className="muted">{t("agent.keys.none")}</p>
              ) : (
                usable.map((key) => (
                  <div key={key.id} className="agent-key">
                    <KeyRound size={13} />
                    <b>{key.label || key.fingerprint}</b>
                    <span>{key.algorithm.replace(/^ssh-/, "")}</span>
                  </div>
                ))
              )}
              {left.length > 0 && (
                <p className="muted">{t("agent.keys.locked", { names: left.map((k) => k.label).join(", ") })}</p>
              )}
            </div>
          )}
          <div className="agent-warn">
            <ShieldAlert size={15} />
            <span>{t("agent.warn")}</span>
          </div>
        </>
      )}
      {props.on && <p className="agent-next">{t("agent.next")}</p>}
    </div>
  );
}

/**
 * The four steps of one sign-in, over and over: the server asks, this Mac
 * signs with the key, the signature goes back, the server is let in.
 */
function AgentDemo(props: { example: Example; server: string }) {
  const t = useT();
  const git = props.example === "git";
  return (
    <div className="agent-demo" aria-hidden="true">
      <div className="agent-command">
        <span className="agent-prompt">{props.server}$</span> {git ? "git pull" : "ssh db-internal"}
      </div>
      <div className="agent-stage">
        <div className="agent-track">
          <i className="agent-dot ask" />
          <i className="agent-dot sign" />
        </div>
        <div className="agent-node mac">
          <span className="agent-icon">
            <Laptop size={18} />
            <KeyRound size={11} className="agent-key-badge" />
          </span>
          <b>{t("agent.mac")}</b>
          <small>{t("agent.mac.sub")}</small>
        </div>
        <div className="agent-node">
          <span className="agent-icon">
            <Server size={18} />
          </span>
          <b>{props.server}</b>
          <small>{t("agent.server")}</small>
        </div>
        <div className="agent-node target">
          <span className="agent-icon">
            {git ? <GitBranch size={18} /> : <Server size={18} />}
            <BadgeCheck size={13} className="agent-ok-badge" />
          </span>
          <b>{git ? "github.com" : "db-internal"}</b>
          <small>{git ? t("agent.target.git") : t("agent.target.ssh")}</small>
        </div>
      </div>
      <div className="agent-steps">
        <span className="s1">{t("agent.step1", { target: git ? "GitHub" : "db-internal" })}</span>
        <span className="s2">{t("agent.step2")}</span>
        <span className="s3">{t("agent.step3")}</span>
        <span className="s4">{t(git ? "agent.step4.git" : "agent.step4.ssh")}</span>
      </div>
    </div>
  );
}
