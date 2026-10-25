// What the Android activity asks the window about, once a second: the
// theme (for the colour of the system bars' icons) and the open sessions
// (for the notification that keeps them connected in the background).

import { t } from "./i18n";
import { useUi } from "./store";

export function pageState(): string {
  const ui = useUi.getState();
  const sessions =
    ui.tabs.filter((tab) => tab.status !== "closed" || tab.reconnect !== null).length +
    ui.guests.filter((guest) => guest.state !== "ended").length;
  return JSON.stringify({
    theme: document.documentElement.dataset.theme ?? "dark",
    sessions,
    title: "MySSH",
    text: t("mobile.keepalive.text", { n: sessions }),
    channel: t("mobile.keepalive.channel"),
  });
}

(window as unknown as { __mysshState: () => string }).__mysshState = pageState;
