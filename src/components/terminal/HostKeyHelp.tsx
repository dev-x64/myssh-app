import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { BadgeCheck, Check, Copy, Fingerprint, Laptop, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { useSettings } from "../../lib/settings";

/** The file a server keeps the public half of its key of this kind in. */
function hostKeyFile(algorithm: string): string {
  const kind = algorithm.includes("ed25519") ? "ed25519" : algorithm.includes("ecdsa") ? "ecdsa" : "rsa";
  return `/etc/ssh/ssh_host_${kind}_key.pub`;
}

/**
 * What trusting a new server means, for someone who has never been asked:
 * drawn as it happens (the server shows its key, MySSH remembers it, and
 * checks it every time after), with when to trust without a second thought
 * and how to check the fingerprint on the server itself. Open by itself
 * while tips are on and this one was never put away.
 */
export function HostKeyHelp(props: { algorithm: string }) {
  const t = useT();
  const fresh = useSettings((s) => s.tips && !s.tipsSeen.includes("hostkey"));
  const [open, setOpen] = useState(fresh);
  const [copied, setCopied] = useState(false);
  const command = `ssh-keygen -lf ${hostKeyFile(props.algorithm)}`;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!open) {
    return (
      <button type="button" className="link-button hk-more" onClick={() => setOpen(true)}>
        {t("hk.what")}
      </button>
    );
  }
  return (
    <div className="hk-help">
      <div className="hk-demo" aria-hidden="true">
        <div className="hk-stage">
          <div className="hk-node">
            <span className="hk-icon mac">
              <Laptop size={18} />
              <BadgeCheck size={13} className="hk-kept" />
            </span>
            <small>MySSH</small>
          </div>
          <div className="hk-track">
            <span className="hk-card">
              <Fingerprint size={12} />
              SHA256
            </span>
          </div>
          <div className="hk-node">
            <span className="hk-icon">
              <Server size={18} />
            </span>
            <small>{t("hk.server")}</small>
          </div>
        </div>
        <div className="hk-steps">
          <span className="s1">{t("hk.step1")}</span>
          <span className="s2">{t("hk.step2")}</span>
          <span className="s3">{t("hk.step3")}</span>
        </div>
      </div>
      <p className="hk-calm">{t("hk.calm")}</p>
      <div className="hk-check">
        <span>{t("hk.check")}</span>
        <div className="hk-command">
          <code className="selectable">{command}</code>
          <button
            type="button"
            className="btn ghost icon small"
            title={t(copied ? "common.copied" : "hk.copy")}
            onClick={() => void writeText(command).then(() => setCopied(true), () => {})}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The help has been read once a server is trusted: next time it starts closed. */
export function hostKeyHelpSeen() {
  const s = useSettings.getState();
  if (!s.tipsSeen.includes("hostkey")) s.set({ tipsSeen: [...s.tipsSeen, "hostkey"] });
}
