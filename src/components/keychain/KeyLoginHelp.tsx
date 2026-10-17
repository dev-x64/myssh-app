import { BadgeCheck, KeyRound, Laptop, Server } from "lucide-react";
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { useSettings } from "../../lib/settings";

/**
 * How signing in with a key works, for someone who has only ever typed
 * passwords: the key is a pair, its public half goes to the server, and
 * the private half, which never leaves this Mac, signs each sign-in.
 * Drawn as it happens; open by itself for newcomers until a key is installed.
 */
export function KeyLoginHelp() {
  const t = useT();
  const fresh = useSettings((s) => s.tips && !s.tipsSeen.includes("keylogin"));
  const [open, setOpen] = useState(fresh);
  if (!open) {
    return (
      <button type="button" className="link-button hk-more" onClick={() => setOpen(true)}>
        {t("kl.how")}
      </button>
    );
  }
  return (
    <div className="hk-demo kl-demo" aria-hidden="true">
      <div className="hk-stage">
        <div className="hk-node">
          <span className="hk-icon kl-mac">
            <Laptop size={18} />
          </span>
          <small>{t("kl.mac")}</small>
        </div>
        <div className="hk-track">
          <span className="hk-card kl-public">
            <KeyRound size={12} />
            {t("kl.public")}
          </span>
          <i className="kl-sign" />
        </div>
        <div className="hk-node">
          <span className="hk-icon kl-server">
            <Server size={18} />
            <BadgeCheck size={13} className="kl-in" />
          </span>
          <small>{t("kl.server")}</small>
        </div>
      </div>
      <div className="hk-steps">
        <span className="s1">{t("kl.step1")}</span>
        <span className="s2">{t("kl.step2")}</span>
        <span className="s3">{t("kl.step3")}</span>
      </div>
    </div>
  );
}

/** A key went onto a server: the help is known, and starts closed from then on. */
export function keyLoginHelpSeen() {
  const s = useSettings.getState();
  if (!s.tipsSeen.includes("keylogin")) s.set({ tipsSeen: [...s.tipsSeen, "keylogin"] });
}
