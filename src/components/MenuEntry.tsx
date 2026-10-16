import { AppWindow } from "lucide-react";
import { useEffect, useState } from "react";
import { reportError } from "../lib/actions";
import { api, type MenuEntryStatus } from "../lib/api";
import { useT } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { useUi } from "../lib/store";
import { Setting } from "./settings/SettingsView";
import { Modal } from "./ui";

function useMenuEntry(): [MenuEntryStatus | null, () => Promise<boolean>] {
  const t = useT();
  const [status, setStatus] = useState<MenuEntryStatus | null>(null);
  useEffect(() => {
    api.menuEntryStatus().then(setStatus, () => setStatus(null));
  }, []);
  const install = async () => {
    try {
      await api.menuEntryInstall();
      setStatus({ available: true, installed: true });
      useUi.getState().toast("success", t("menu_entry.done"));
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  };
  return [status, install];
}

/**
 * On Linux, run as an AppImage, the app is in no menu: once the setup is
 * done, it offers to put itself there, and asks only once.
 */
export function MenuEntryOffer() {
  const t = useT();
  const [status, install] = useMenuEntry();
  const asked = useSettings((s) => s.menuEntryAsked);
  const setupDone = useSettings((s) => s.setupDone);
  const [busy, setBusy] = useState(false);
  if (!status?.available || status.installed || asked || !setupDone) return null;
  const close = () => useSettings.getState().set({ menuEntryAsked: true });
  return (
    <Modal
      title={t("menu_entry.title")}
      icon={<AppWindow size={17} />}
      onClose={close}
      onSubmit={async () => {
        setBusy(true);
        if (await install()) close();
        setBusy(false);
      }}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            {t("menu_entry.later")}
          </button>
          <button type="submit" className="btn primary" disabled={busy} data-autofocus>
            {t("menu_entry.add")}
          </button>
        </>
      }
    >
      <p>{t("menu_entry.text")}</p>
    </Modal>
  );
}

/** The same, in Settings, for whoever said "not now". */
export function MenuEntrySetting() {
  const t = useT();
  const [status, install] = useMenuEntry();
  if (!status?.available) return null;
  return (
    <Setting name={t("menu_entry.setting")} hint={t("menu_entry.setting.hint")}>
      {status.installed && <span className="muted">{t("menu_entry.installed")}</span>}
      <button className="btn small" onClick={() => void install()}>
        {status.installed ? t("menu_entry.again") : t("menu_entry.add")}
      </button>
    </Setting>
  );
}
