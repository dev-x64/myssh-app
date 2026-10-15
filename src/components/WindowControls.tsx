import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";

/**
 * The window's own buttons, for Windows: there the app draws its title bar
 * itself, so that the tabs sit in it as they do on the Mac, and with the
 * system's frame gone its three buttons have to be here.
 */
export function WindowControls() {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const update = () => void appWindow.isMaximized().then(setMaximized).catch(() => {});
    update();
    const unlisten = appWindow.onResized(update);
    return () => void unlisten.then((off) => off());
  }, []);

  const appWindow = getCurrentWindow();
  return (
    <div className="window-controls">
      <button title={t("window.minimize")} onClick={() => void appWindow.minimize()}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" />
        </svg>
      </button>
      <button
        title={t(maximized ? "window.restore" : "window.maximize")}
        onClick={() => void appWindow.toggleMaximize()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          {maximized ? <path d="M2.5 2.5v-2h7v7h-2M.5 2.5h7v7h-7z" /> : <path d="M.5.5h9v9h-9z" />}
        </svg>
      </button>
      <button className="close" title={t("window.close")} onClick={() => void appWindow.close()}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" />
        </svg>
      </button>
    </div>
  );
}
