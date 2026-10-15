import { useCallback, useEffect, useState } from "react";
import { reportError } from "../../lib/actions";
import { api } from "../../lib/api";
import { leaveShare } from "../../lib/guest";
import { useT } from "../../lib/i18n";
import { usePlan } from "../../lib/plan";
import { WINDOWS } from "../../lib/platform";
import { useSettings } from "../../lib/settings";
import { stopShare, useShare } from "../../lib/share";
import { directAllowed } from "../../lib/sharewire";
import { useUi } from "../../lib/store";
import { GetProButton, ProBadge } from "../cloud/Pro";
import { cx, Switch } from "../ui";

type Direct = "checking" | "ok" | "blocked";

/**
 * Shared sessions are off until turned on here. Turning them on is also
 * when macOS is asked to let the app onto the local network, so that the
 * question comes at a moment when it makes sense. Inviting takes Pro, which
 * the section says, with the way to it for an account on Free.
 */
export function SharingSection() {
  const t = useT();
  const sharing = useSettings((s) => s.sharing);
  const plan = usePlan((s) => s.plan?.plan);
  const [direct, setDirect] = useState<Direct>("checking");

  const check = useCallback(() => {
    setDirect("checking");
    void directAllowed().then((allowed) => setDirect(allowed ? "ok" : "blocked"));
  }, []);
  useEffect(() => {
    if (sharing) check();
  }, [sharing, check]);
  // Back from System Settings, where it may just have been allowed.
  useEffect(() => {
    if (!sharing || direct !== "blocked") return;
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [sharing, direct, check]);

  const toggle = (on: boolean) => {
    useSettings.getState().set({ sharing: on });
    if (on) return;
    // Nothing stays shared with no button left to stop it.
    for (const tabId of Object.keys(useShare.getState().shares)) stopShare(tabId);
    for (const guest of useUi.getState().guests) leaveShare(guest.id);
  };

  return (
    <>
      <div className="section-title" id="settings-sharing">
        {t("settings.sharing")}
        {plan !== "pro" && <ProBadge />}
      </div>
      <div className="table">
        {plan === "free" && (
          <div className="setting">
            <div className="setting-text">
              <div className="hint">{t("share.pro")}</div>
            </div>
            <div className="control">
              <GetProButton small />
            </div>
          </div>
        )}
        <div className="setting">
          <div className="setting-text">
            <div className="name">{t("settings.sharing.enable")}</div>
            <div className="hint">{t("settings.sharing.hint")}</div>
          </div>
          <div className="control">
            <Switch on={sharing} onChange={toggle} />
          </div>
        </div>
        {sharing && (
          <div className="setting">
            <div className="setting-text">
              <div className="name">
                {t("settings.direct")}{" "}
                <span className={cx("chip", direct === "ok" && "ok", direct === "blocked" && "danger")}>
                  {t(`settings.direct.${direct}`)}
                </span>
              </div>
              <div className="hint">{t(`settings.direct.hint.${direct}`)}</div>
              {direct === "blocked" && (
                <div className="setting-actions">
                  <button className="btn small" onClick={check}>
                    {t("settings.direct.recheck")}
                  </button>
                  {/* The page it opens is macOS's own; Windows has none like it. */}
                  {!WINDOWS && (
                    <button
                      className="btn small"
                      onClick={() => void api.openNetworkPrivacy().catch(reportError)}
                    >
                      {t("settings.direct.open")}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
