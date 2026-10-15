// Cloud sync as the app runs it: when to sync, what state it is in, and
// keeping the synced preferences and the settings store in step.

import { create } from "zustand";
import { api, asApiError, type ApiError, type ConflictNote } from "./api";
import { t } from "./i18n";
import { useSettings, type Settings } from "./settings";
import { useUi, useVault } from "./store";

/** Preferences that follow the user; everything else stays on the device. */
const SYNCED: (keyof Settings)[] = [
  "locale",
  "theme",
  "termTheme",
  "fontFamily",
  "fontSize",
  "lineHeight",
  "cursorStyle",
  "cursorBlink",
  "cursorColor",
  "scrollback",
  "copyOnSelect",
  "autoReconnect",
  "filesFollowTerminal",
  "suggestions",
];

const AFTER_CHANGE_MS = 2500;
const PERIOD_MS = 60_000;
const SAVE_SETTINGS_MS = 700;
/** A sync shorter than this passes without a sign of it anywhere. */
const SHOW_AFTER_MS = 1500;
/** A sync asked for this soon after the last one is not worth making. */
const FRESH_MS = 5000;

interface CloudStore {
  state: "idle" | "syncing" | "offline" | "error";
  error: ApiError | null;
  /** Decisions from recent syncs, newest first, until dismissed. */
  conflicts: ConflictNote[];
  dismissConflicts: () => void;
}

export const useCloud = create<CloudStore>((set) => ({
  state: "idle",
  error: null,
  conflicts: [],
  dismissConflicts: () => set({ conflicts: [] }),
}));

let running = false;
let again = false;
let timer: number | undefined;
/** When the last sync ended, however it ended. */
let endedAt = 0;

/** Syncs now. Concurrent calls collapse into one follow-up run. */
export async function syncNow(): Promise<void> {
  const account = useVault.getState().snapshot.cloud;
  if (!account || account.revoked) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  // Most syncs are over in a moment and are nobody's business. Only one
  // that takes a while is shown as going on.
  const shown = window.setTimeout(() => useCloud.setState({ state: "syncing" }), SHOW_AFTER_MS);
  try {
    const report = await api.cloudSync(t("cloud.copy_suffix"));
    useCloud.setState((s) => ({
      state: "idle",
      error: null,
      conflicts: [...report.conflicts, ...s.conflicts].slice(0, 50),
    }));
  } catch (e) {
    const error = asApiError(e);
    // Being offline is ordinary: changes wait, nothing is lost.
    useCloud.setState({ state: error.code === "offline" ? "offline" : "error", error });
  } finally {
    window.clearTimeout(shown);
    running = false;
    endedAt = Date.now();
    await useVault.getState().refresh();
    if (again) {
      again = false;
      schedule(300);
    }
  }
}

function schedule(delay: number) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void syncNow(), delay);
}

/**
 * Syncs at once, unless it has just been done: for the moments when a host
 * is about to be used or edited, so that what another device changed a
 * minute ago is already here.
 */
function catchUp() {
  if (!running && Date.now() - endedAt > FRESH_MS) schedule(0);
}

function syncedPart(settings: Settings): Record<string, unknown> {
  return Object.fromEntries(SYNCED.map((key) => [key, settings[key]]));
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Starts background sync and ties the settings store to the vault.
 *
 * The vault is the source of truth for synced preferences: what arrives
 * from another device is applied here, and what changes here is saved to
 * the vault, from where sync carries it on.
 */
export function startCloud() {
  let saveTimer: number | undefined;
  let lastSeen: unknown = undefined;

  const applyFromVault = () => {
    const { snapshot, loaded, loadError } = useVault.getState();
    if (!loaded || loadError) return;
    const stored = snapshot.settings;
    if (stored === null) {
      // First run with this vault: seed it from what the device has.
      if (lastSeen !== null) {
        lastSeen = null;
        void api.settingsSave(syncedPart(useSettings.getState())).then(() => useVault.getState().refresh());
      }
      return;
    }
    if (same(stored, lastSeen)) return;
    lastSeen = stored;
    const current = syncedPart(useSettings.getState());
    const incoming = Object.fromEntries(
      SYNCED.filter((key) => key in stored).map((key) => [key, stored[key]]),
    );
    if (!same({ ...current, ...incoming }, current)) {
      useSettings.setState(incoming as Partial<Settings>);
    }
  };

  useVault.subscribe((state, previous) => {
    applyFromVault();
    const account = state.snapshot.cloud;
    if (!account || account.revoked) return;
    // Something local is waiting to be sent, or we have just signed in.
    if (account.pending > 0 || !previous.snapshot.cloud) schedule(AFTER_CHANGE_MS);
  });

  useSettings.subscribe((state) => {
    const { snapshot, loaded, loadError } = useVault.getState();
    if (!loaded || loadError) return;
    const part = syncedPart(state);
    if (same(part, snapshot.settings)) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      lastSeen = part;
      void api
        .settingsSave(part)
        .then(() => useVault.getState().refresh())
        .catch(() => {});
    }, SAVE_SETTINGS_MS);
  });

  // A tab being opened to a host, or a host being opened for editing.
  useUi.subscribe((state, previous) => {
    if (state.tabs.length > previous.tabs.length || (state.hostPanel && !previous.hostPanel)) catchUp();
  });

  applyFromVault();
  window.setInterval(() => void syncNow(), PERIOD_MS);
  window.addEventListener("focus", () => schedule(500));
  window.addEventListener("online", () => schedule(500));
  schedule(1200);
}
