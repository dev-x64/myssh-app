import { File, Keyboard, Laptop, Link2, MonitorSmartphone } from "lucide-react";
import { useT } from "../../lib/i18n";

/**
 * A file dragged from this Mac's pane to the server's, for the file
 * manager's tip: it flies across, the copy fills its bar, and it is there.
 */
export function FilesDemo() {
  const t = useT();
  return (
    <div className="fd-demo" aria-hidden="true">
      <div className="fd-pane">
        <b>{t("files.this_mac")}</b>
        <span className="fd-row fd-src">
          <File size={11} />
          app.tar.gz
        </span>
        <span className="fd-row dim">
          <File size={11} />
          notes.md
        </span>
      </div>
      <div className="fd-pane">
        <b>web-1</b>
        <span className="fd-row dim">
          <File size={11} />
          nginx.conf
        </span>
        <span className="fd-row fd-new">
          <File size={11} />
          app.tar.gz
        </span>
      </div>
      <span className="fd-fly">
        <File size={11} />
        app.tar.gz
      </span>
      <span className="fd-bar">
        <i />
      </span>
    </div>
  );
}

/**
 * Sharing a terminal, for its panel: the link goes to someone, it opens
 * their MySSH on this terminal, and the keyboard passes between you.
 */
export function ShareDemo() {
  const t = useT();
  return (
    <div className="hk-demo sd-demo" aria-hidden="true">
      <div className="hk-stage">
        <div className="hk-node">
          <span className="hk-icon sd-you">
            <Laptop size={18} />
          </span>
          <small>{t("share.demo.you")}</small>
        </div>
        <div className="hk-track">
          <span className="hk-card sd-link">
            <Link2 size={12} />
            {t("share.demo.link")}
          </span>
          <span className="sd-key">
            <Keyboard size={13} />
          </span>
        </div>
        <div className="hk-node">
          <span className="hk-icon sd-guest">
            <MonitorSmartphone size={18} />
          </span>
          <small>{t("share.demo.guest")}</small>
        </div>
      </div>
      <div className="hk-steps">
        <span className="s1">{t("share.demo.step1")}</span>
        <span className="s2">{t("share.demo.step2")}</span>
        <span className="s3">{t("share.demo.step3")}</span>
      </div>
    </div>
  );
}
