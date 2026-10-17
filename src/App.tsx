import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  FolderOpen,
  KeyRound,
  LayoutGrid,
  Plus,
  Search,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  SquareTerminal,
  Terminal as TerminalIcon,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { AccountMenu } from "./components/cloud/AccountMenu";
import { CloudView } from "./components/cloud/CloudView";
import { Welcome } from "./components/cloud/Welcome";
import { Setup } from "./components/setup/Setup";
import { HostsView } from "./components/hosts/HostsView";
import { KeychainView } from "./components/keychain/KeychainView";
import { KnownHostsView } from "./components/known/KnownHostsView";
import { SettingsView } from "./components/settings/SettingsView";
import { SnippetsView } from "./components/snippets/SnippetsView";
import { RunGroupList } from "./components/terminal/RunGroup";
import { TerminalPane } from "./components/terminal/TerminalPane";
import { cx, Toasts } from "./components/ui";
import { api } from "./lib/api";
import { startCloud } from "./lib/cloud";
import { startPlan } from "./lib/plan";
import { errorText, translate, useT, type MessageKey } from "./lib/i18n";
import { startUpdates, useUpdate } from "./lib/update";
import { NewTab } from "./components/hosts/NewTab";
import { GuestPane, SharingOffDialog } from "./components/terminal/GuestPane";
import { ForwardsButton } from "./components/terminal/ForwardsPanel";
import { ShareButton, ShareMark } from "./components/terminal/SharePanel";
import { leaveShare, receiveInvite, startGuestSync } from "./lib/guest";
import { UpdateButton, UpdateNotice } from "./components/UpdateNotice";
import { MenuEntryOffer } from "./components/MenuEntry";
import { ChangeEmailDialog, openEmailDialog } from "./components/cloud/ChangeEmail";
import { WindowControls } from "./components/WindowControls";
import { VaultError } from "./components/VaultError";
import { getSession, openLocal, requestCloseEditor, requestCloseTab, startSessionSync } from "./lib/sessions";
import { MAC, WINDOWS } from "./lib/platform";
import { ACCENT_COLOR, isDark, onSystemThemeChange, useSettings } from "./lib/settings";
import { isLocalTab, useUi, useVault, type View } from "./lib/store";

const NAV: { view: View; label: MessageKey; icon: typeof Server }[] = [
  { view: "hosts", label: "nav.hosts", icon: Server },
  { view: "keychain", label: "nav.keychain", icon: KeyRound },
  { view: "snippets", label: "nav.snippets", icon: SquareTerminal },
  { view: "known_hosts", label: "nav.known_hosts", icon: ShieldCheck },
];

/**
 * The shortcuts where there is no menu bar to own them, which is Windows.
 * They take Shift with Ctrl: Ctrl with a letter belongs to the shell
 * (Ctrl+W deletes a word, Ctrl+K the rest of a line). Keys are told by
 * where they are on the keyboard, so another layout changes nothing.
 */
const SHORTCUTS: Record<string, string> = {
  "shift+KeyT": "new_tab",
  "shift+KeyN": "new_host",
  "shift+KeyW": "close_tab",
  "shift+KeyH": "hosts",
  "shift+KeyF": "find",
  "shift+KeyE": "files",
  "shift+KeyS": "snippets",
  "shift+KeyK": "clear",
  Tab: "next_tab",
  "shift+Tab": "prev_tab",
  Comma: "settings",
  Equal: "font_bigger",
  Minus: "font_smaller",
  Digit0: "font_reset",
};

function onShortcut(event: KeyboardEvent) {
  if (!event.ctrlKey || event.altKey || event.metaKey) return;
  const action = SHORTCUTS[`${event.shiftKey ? "shift+" : ""}${event.code}`];
  if (!action) return;
  // Taken here, before the terminal sees it and passes it on to the shell.
  event.preventDefault();
  event.stopPropagation();
  onMenu(action);
}

function onMenu(id: string) {
  const ui = useUi.getState();
  const settings = useSettings.getState();
  const activeTab = ui.tabs.find((tab) => tab.id === ui.active);
  switch (id) {
    case "settings":
      ui.goHome("settings");
      break;
    case "hosts":
      ui.goHome("hosts");
      break;
    case "new_tab":
      ui.openNewTab();
      break;
    case "check_updates":
      void checkForUpdates();
      break;
    case "new_host":
      ui.setHostPanel({ mode: "new", groupId: null });
      ui.goHome("hosts");
      break;
    case "close_tab":
      // With a file open, Cmd+W closes the file first.
      if (activeTab?.editor) requestCloseEditor(activeTab.id);
      else if (activeTab) requestCloseTab(activeTab.id);
      else if (ui.active === "new") ui.closeNewTab();
      else if (ui.guests.some((guest) => guest.id === ui.active)) leaveShare(ui.active);
      break;
    case "next_tab":
      ui.cycle(1);
      break;
    case "prev_tab":
      ui.cycle(-1);
      break;
    case "find":
      if (activeTab) ui.patchTab(activeTab.id, { searchOpen: true });
      break;
    case "files":
      if (activeTab && !isLocalTab(activeTab)) ui.patchTab(activeTab.id, { files: !activeTab.files });
      break;
    case "snippets":
      if (activeTab) ui.patchTab(activeTab.id, { side: activeTab.side === "snippets" ? null : "snippets" });
      else ui.goHome("snippets");
      break;
    case "font_bigger":
      settings.bumpFontSize(1);
      break;
    case "font_smaller":
      settings.bumpFontSize(-1);
      break;
    case "font_reset":
      settings.bumpFontSize(0);
      break;
    case "clear":
      if (activeTab) getSession(activeTab.id)?.clear();
      break;
  }
}

/** A look for updates the user asked for: the answer is always shown. */
async function checkForUpdates() {
  const update = useUpdate.getState();
  const found = await update.check(false);
  const after = useUpdate.getState();
  if (found) after.setDialog(true);
  else if (after.error) {
    useUi.getState().toast("error", errorText(after.error), after.error.detail ?? undefined);
  } else {
    useUi.getState().toast("success", translate(useSettings.getState().locale, "update.none"));
  }
}

/**
 * A link the app was opened with: an invitation to a shared terminal, or
 * the account's page in the browser asking for something only the app can
 * do, since it needs the master password.
 */
function receiveLink(link: string) {
  if (/^myssh:\/\/account\/email\/?$/.test(link)) openEmailDialog();
  else receiveInvite(link);
}

function useBootstrap() {
  const locale = useSettings((s) => s.locale);
  const theme = useSettings((s) => s.theme);
  const accent = useSettings((s) => s.accent);
  const [, rerender] = useState(0);

  useEffect(() => {
    // A reloaded window cannot reach sessions it opened before the reload.
    void api.sessionCloseAll().catch(() => {});
    void useVault.getState().init();
    startSessionSync();
    startCloud();
    startPlan();
    startUpdates();
    startGuestSync();
    // Invitations the app was opened with, now and whenever one arrives.
    const takeLinks = () =>
      void api
        .linksTake()
        .then((links) => links.forEach((link) => receiveLink(link)))
        .catch(() => {});
    takeLinks();
    const unlisten = [
      listen("vault-changed", () => void useVault.getState().refresh()),
      listen<string>("menu", (event) => onMenu(event.payload)),
      listen("link-arrived", takeLinks),
    ];
    // Without the Mac's menu bar, the window takes the shortcuts itself.
    if (!MAC) window.addEventListener("keydown", onShortcut, true);
    const offTheme = onSystemThemeChange(() => rerender((n) => n + 1));
    return () => {
      offTheme();
      window.removeEventListener("keydown", onShortcut, true);
      for (const pending of unlisten) void pending.then((off) => off());
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = isDark(theme) ? "dark" : "light";
    document.documentElement.dataset.accent = accent;
    document.documentElement.style.setProperty("--accent-base", ACCENT_COLOR[accent] ?? ACCENT_COLOR.orange);
  });

  useEffect(() => {
    document.documentElement.lang = locale;
    void invoke("menu_set_locale", { locale }).catch(() => {});
  }, [locale]);
}

function useFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const update = () => void appWindow.isFullscreen().then(setFullscreen).catch(() => {});
    update();
    const pending = appWindow.onResized(update);
    return () => void pending.then((off) => off());
  }, []);
  return fullscreen;
}

function TitleBar() {
  const t = useT();
  const tabs = useUi((s) => s.tabs);
  const active = useUi((s) => s.active);
  const activate = useUi((s) => s.activate);
  const patchTab = useUi((s) => s.patchTab);
  const newTab = useUi((s) => s.newTab);
  const guests = useUi((s) => s.guests);
  const openNewTab = useUi((s) => s.openNewTab);
  const closeNewTab = useUi((s) => s.closeNewTab);
  const activeTab = tabs.find((tab) => tab.id === active);
  const groupFocus = useUi((s) => s.groupFocus);
  const fullscreen = useFullscreen();

  return (
    <header className={cx("titlebar", fullscreen && "fullscreen")} data-tauri-drag-region>
      <div className="tabs" role="tablist">
        <div
          role="tab"
          aria-selected={active === "home"}
          className={cx("tab pinned", active === "home" && "active")}
          onMouseDown={() => activate("home")}
        >
          <LayoutGrid size={15} />
          <span className="tab-title">{t("tab.home")}</span>
        </div>
        {tabs.map((tab, index) => {
          // The terminals of a group are one tab, where the first of them stands.
          if (tab.group) {
            const group = tab.group;
            if (tabs.findIndex((other) => other.group?.id === group.id) !== index) return null;
            const members = tabs.filter((other) => other.group?.id === group.id);
            const on = members.some((member) => member.id === active);
            const done = members.filter((member) => member.runState === "done").length;
            const status = members.some((m) => m.status === "connecting")
              ? "connecting"
              : members.every((m) => m.status === "closed")
                ? "closed"
                : "connected";
            const open = () => activate(groupFocus[group.id] ?? members[0].id);
            return (
              <div
                key={group.id}
                role="tab"
                aria-selected={on}
                className={cx("tab", on && "active")}
                title={group.title}
                onMouseDown={(e) => {
                  if (e.button === 0) open();
                }}
              >
                <span className={cx("dot", status)} />
                <span className="tab-title">{group.title}</span>
                <span className={cx("tab-count", done === members.length && "all")}>
                  {done}/{members.length}
                </span>
                <button
                  className="tab-close"
                  aria-label={t("tab.close")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => members.forEach((member) => requestCloseTab(member.id))}
                >
                  <X size={12} />
                </button>
              </div>
            );
          }
          return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active === tab.id}
            className={cx("tab", active === tab.id && "active")}
            title={tab.title}
            onMouseDown={(e) => {
              if (e.button === 0) activate(tab.id);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) requestCloseTab(tab.id);
            }}
          >
            <span className={cx("dot", tab.status)} />
            <span className="tab-title">{tab.title}</span>
            <ShareMark tabId={tab.id} />
            <button
              className="tab-close"
              aria-label={t("tab.close")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => requestCloseTab(tab.id)}
            >
              <X size={12} />
            </button>
          </div>
          );
        })}
        {guests.map((guest) => (
          <div
            key={guest.id}
            role="tab"
            aria-selected={active === guest.id}
            className={cx("tab", active === guest.id && "active")}
            title={guest.title || t("guest.tab")}
            onMouseDown={(e) => {
              if (e.button === 0) activate(guest.id);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) leaveShare(guest.id);
            }}
          >
            <Users size={13} />
            <span className="tab-title">{guest.title || t("guest.tab")}</span>
            <button
              className="tab-close"
              aria-label={t("guest.leave")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => leaveShare(guest.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {newTab && (
          <div
            role="tab"
            aria-selected={active === "new"}
            className={cx("tab", active === "new" && "active")}
            onMouseDown={(e) => {
              if (e.button === 0) activate("new");
            }}
            onAuxClick={(e) => {
              if (e.button === 1) closeNewTab();
            }}
          >
            <Plus size={13} />
            <span className="tab-title">{t("newtab.title")}</span>
            <button
              className="tab-close"
              aria-label={t("tab.close")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={closeNewTab}
            >
              <X size={12} />
            </button>
          </div>
        )}
        {!newTab && (
          <button className="tab-add" title={t("newtab.open")} aria-label={t("newtab.open")} onClick={openNewTab}>
            <Plus size={15} />
          </button>
        )}
      </div>
      <div className="titlebar-drag" data-tauri-drag-region />
      {activeTab && (
        <div className="tools">
          <button
            className={cx("btn ghost icon small", activeTab.searchOpen && "on")}
            title={t("term.tools.find")}
            onClick={() => patchTab(activeTab.id, { searchOpen: !activeTab.searchOpen })}
          >
            <Search size={15} />
          </button>
          {/* The files and sharing are a server's; the local terminal has neither. */}
          {!isLocalTab(activeTab) && (
            <button
              className={cx("btn ghost icon small", activeTab.files && "on")}
              title={t("term.tools.files")}
              onClick={() => patchTab(activeTab.id, { files: !activeTab.files })}
            >
              <FolderOpen size={15} />
            </button>
          )}
          <button
            className={cx("btn ghost icon small", activeTab.side === "snippets" && "on")}
            title={t("term.tools.snippets")}
            onClick={() =>
              patchTab(activeTab.id, { side: activeTab.side === "snippets" ? null : "snippets" })
            }
          >
            <SquareTerminal size={15} />
          </button>
          {!isLocalTab(activeTab) && <ForwardsButton tab={activeTab} />}
          {!isLocalTab(activeTab) && <ShareButton tab={activeTab} />}
        </div>
      )}
      <UpdateButton />
      <UpdateNotice />
      <MenuEntryOffer />
      <ChangeEmailDialog />
      <AccountMenu />
      {WINDOWS && <WindowControls />}
    </header>
  );
}

function Home() {
  const t = useT();
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const version = useVault((s) => s.status?.version);
  const hostCount = useVault((s) => s.snapshot.hosts.length);
  const keychainCount = useVault((s) => s.snapshot.keys.length + s.snapshot.identities.length);
  const snippetCount = useVault((s) => s.snapshot.snippets.length);
  const count = (target: View) =>
    target === "hosts"
      ? hostCount
      : target === "keychain"
        ? keychainCount
        : target === "snippets"
          ? snippetCount
          : 0;

  return (
    <div className="home">
      <nav className="sidebar">
        {NAV.map(({ view: target, label, icon: Icon }) => (
          <button
            key={target}
            className={cx("nav-item", view === target && "active")}
            onClick={() => setView(target)}
          >
            <Icon size={16} />
            {t(label)}
            {count(target) > 0 && <span className="count">{count(target)}</span>}
          </button>
        ))}
        {/* A terminal on this computer, in a tab of its own. */}
        <button className="nav-item nav-local" onClick={openLocal}>
          <TerminalIcon size={16} />
          {t("nav.local")}
        </button>
        <div className="spacer" />
        <button
          className={cx("nav-item", view === "settings" && "active")}
          onClick={() => setView("settings")}
        >
          <SettingsIcon size={16} />
          {t("nav.settings")}
        </button>
        {version && <div className="sidebar-version">MySSH {version}</div>}
      </nav>
      <div className="content">
        {view === "hosts" && <HostsView />}
        {view === "keychain" && <KeychainView />}
        {view === "snippets" && <SnippetsView />}
        {view === "known_hosts" && <KnownHostsView />}
        {view === "cloud" && <CloudView />}
        {view === "settings" && <SettingsView />}
      </div>
    </div>
  );
}

export default function App() {
  useBootstrap();
  const loaded = useVault((s) => s.loaded);
  const failed = useVault((s) => s.loadError !== null);
  const tabs = useUi((s) => s.tabs);
  const guests = useUi((s) => s.guests);
  const active = useUi((s) => s.active);
  // First launch: offer to sign in before anything else. Skipped for good
  // once the user signs in or chooses to go on without an account.
  const signedOut = useVault(
    (s) => (s.status?.cloud_available ?? false) && s.snapshot.cloud === null,
  );
  const welcomed = useSettings((s) => s.welcomed);
  const welcome = signedOut && !welcomed;
  // The very first launch: the basics, then the account. Later, signing
  // out brings back only the sign-in.
  const setup = !useSettings((s) => s.setupDone);
  const activeGroup = tabs.find((tab) => tab.id === active)?.group ?? null;

  return (
    <div className="app">
      <TitleBar />
      <div className={cx("body", activeGroup && "grouped")}>
        {!loaded ? null : failed ? (
          <VaultError />
        ) : (
          <>
            {active === "home" && (setup ? <Setup /> : welcome ? <Welcome /> : <Home />)}
            {active === "new" && <NewTab />}
            {activeGroup && (
              <RunGroupList tabs={tabs.filter((tab) => tab.group?.id === activeGroup.id)} active={active} />
            )}
            {tabs.map((tab) => (
              <TerminalPane key={tab.id} tab={tab} active={active === tab.id} />
            ))}
            {guests.map((guest) => (
              <GuestPane key={guest.id} guest={guest} active={active === guest.id} />
            ))}
          </>
        )}
      </div>
      <SharingOffDialog />
      <Toasts />
    </div>
  );
}
