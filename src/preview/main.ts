// The interface preview: the app's real window in a browser, with the Rust
// core replaced by made-up answers (see ipc.ts), so that the interface can
// be looked at and clicked through without building the app. Started with
// `npm run ui`; never part of a build.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createHandler } from "./ipc";
import { mountPanel } from "./panel";
import { loadScenario } from "./scenario";

const scenario = loadScenario();

// Read once, as the app starts: the system it believes it runs on.
const AGENTS = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MySSH-preview",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) MySSH-preview",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Mobile MySSH-preview",
};
if (scenario.os !== "mac") {
  Object.defineProperty(navigator, "userAgent", { value: AGENTS[scenario.os] });
}

// A fresh browser starts past the first-launch setup, so that pictures show
// the app itself; the panel's "Стартовая настройка" brings the setup back.
try {
  if (localStorage.getItem("myssh.settings") === null) {
    localStorage.setItem("myssh.settings", JSON.stringify({ state: { setupDone: true }, version: 2 }));
  }
} catch {
  // No storage: the setup shows, which is the app's own first launch.
}

mockWindows("main");
mockIPC(createHandler(scenario), { shouldMockEvents: true });

await import("../main");
if (scenario.panel) mountPanel(scenario);
