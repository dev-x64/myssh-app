import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/app.css";

import { createRoot } from "react-dom/client";
import App from "./App";
import { WINDOWS } from "./lib/platform";

// The stylesheet lays the window out for the Mac and makes allowances from this.
document.documentElement.dataset.platform = WINDOWS ? "windows" : "mac";

// Handles for the development-only test bridge; absent from release builds.
if (import.meta.env.DEV) {
  void Promise.all([
    import("./lib/store"),
    import("./lib/sessions"),
    import("./lib/settings"),
    import("./lib/api"),
    import("./lib/cloud"),
    import("./lib/external"),
    import("./lib/share"),
    import("./lib/guest"),
  ]).then(([store, sessions, settings, api, cloud, external, share, guest]) => {
    Object.assign(window, {
      __myssh: { ...store, ...sessions, ...settings, ...api, ...cloud, ...external, ...share, ...guest },
    });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
