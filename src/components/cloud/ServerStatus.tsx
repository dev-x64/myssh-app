import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CloudCheck } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { cx } from "../ui";

/** How often the server is asked again: sooner while it is unreachable. */
const RECHECK_ONLINE_MS = 60_000;
const RECHECK_OFFLINE_MS = 15_000;
const BRAND = "myssh.app";

/**
 * Whether the cloud server can be reached, kept up to date while mounted.
 * `check` is `null` until the first answer arrives.
 */
export function useCloudCheck() {
  const [check, setCheck] = useState<CloudCheck | null>(null);
  const [checking, setChecking] = useState(true);
  const timer = useRef<number | undefined>(undefined);
  const alive = useRef(true);

  const run = useCallback(async () => {
    window.clearTimeout(timer.current);
    setChecking(true);
    let result: CloudCheck | null = null;
    try {
      result = await api.cloudCheck();
    } catch {
      // The command itself never fails; treat the unexpected as "not reachable".
    }
    if (!alive.current) return;
    setCheck(result ?? { host: "", online: false, registration_open: false, error: null });
    setChecking(false);
    timer.current = window.setTimeout(
      () => void run(),
      result?.online ? RECHECK_ONLINE_MS : RECHECK_OFFLINE_MS,
    );
  }, []);

  useEffect(() => {
    alive.current = true;
    void run();
    const onBack = () => void run();
    window.addEventListener("online", onBack);
    window.addEventListener("focus", onBack);
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
      window.removeEventListener("online", onBack);
      window.removeEventListener("focus", onBack);
    };
  }, [run]);

  return { check, checking, recheck: run };
}

/**
 * What the cloud is called on screen. The server's address is not shown:
 * it is fixed in the build and is of no use to the user.
 */
function brandOf(host: string): string {
  const name = host.split(":")[0];
  return name === BRAND || name.endsWith(`.${BRAND}`) ? BRAND : "dev";
}

/** One line saying whether the cloud server is reachable right now. */
export function ServerStatus(props: ReturnType<typeof useCloudCheck>) {
  const t = useT();
  const { check, checking, recheck } = props;
  const state = check === null ? "checking" : check.online ? "online" : "offline";

  return (
    <div className={cx("server-status", state)} role="status">
      <span className={cx("dot", state === "online" ? "connected" : state === "offline" ? "closed" : "connecting")} />
      <div className="server-status-text">
        <div className="server-status-title">
          {state === "checking"
            ? t("cloud.server.checking")
            : state === "online"
              ? t("cloud.server.online")
              : t("cloud.server.offline")}
          {check?.host && <span className="server-brand">{brandOf(check.host)}</span>}
        </div>
        {state === "offline" && <div className="server-status-hint">{t("cloud.server.offline.hint")}</div>}
      </div>
      {state !== "online" && (
        <button
          type="button"
          className="btn ghost icon small"
          title={t("cloud.server.recheck")}
          disabled={checking}
          onClick={() => void recheck()}
        >
          <RotateCw size={13} className={cx(checking && "spin")} />
        </button>
      )}
    </div>
  );
}
