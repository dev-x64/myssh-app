// The window on a phone. The same sections, terminals and dialogs as on a
// computer, laid out for one hand: one screen at a time, the sections as
// tabs along the bottom, open terminals under Sessions, and a terminal
// across the whole screen with the keys a phone lacks above its keyboard.

import {
  ArrowLeft,
  Cable,
  ChevronRight,
  Cloud,
  KeyRound,
  Menu as MenuIcon,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  SquareTerminal,
  Layers,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { setBackFallback } from "../../lib/back";
import "../../lib/pageState";
import { useT, type MessageKey } from "../../lib/i18n";
import { getSession, requestCloseEditor } from "../../lib/sessions";
import { useSettings } from "../../lib/settings";
import { useUi, useVault, type View } from "../../lib/store";
import { AccountMenu } from "../cloud/AccountMenu";
import { ChangeEmailDialog } from "../cloud/ChangeEmail";
import { CloudView } from "../cloud/CloudView";
import { Welcome } from "../cloud/Welcome";
import { ForwardsView } from "../forwards/ForwardsView";
import { HostsView } from "../hosts/HostsView";
import { KeychainView } from "../keychain/KeychainView";
import { KnownHostsView } from "../known/KnownHostsView";
import { SettingsView } from "../settings/SettingsView";
import { Setup } from "../setup/Setup";
import { SnippetsView } from "../snippets/SnippetsView";
import { GuestPane, SharingOffDialog } from "../terminal/GuestPane";
import { TerminalPane } from "../terminal/TerminalPane";
import { cx, Toasts } from "../ui";
import { VaultError } from "../VaultError";
import { ExtraKeys } from "./ExtraKeys";
import { LinkSheet } from "./LinkSheet";
import { SessionSheet, SessionsView } from "./Sessions";
import { GuestBar, TermBar } from "./TermBar";
import { usePinchZoom } from "./pinch";
import { useTouchScroll } from "./touchScroll";

/** The tabs along the bottom. */
const TABS: { view: View; label: MessageKey; icon: LucideIcon }[] = [
  { view: "hosts", label: "nav.hosts", icon: Server },
  { view: "keychain", label: "nav.keychain", icon: KeyRound },
  { view: "snippets", label: "nav.snippets", icon: SquareTerminal },
  { view: "sessions", label: "mnav.sessions", icon: Layers },
  { view: "more", label: "mnav.more", icon: MenuIcon },
];

/** The sections that are reached through More, and lead back to it. */
const UNDER_MORE: View[] = ["forwards", "known_hosts", "cloud", "settings"];

const TITLES: Record<View, MessageKey> = {
  hosts: "nav.hosts",
  keychain: "nav.keychain",
  snippets: "nav.snippets",
  sessions: "mnav.sessions",
  more: "mnav.more",
  forwards: "nav.forwards",
  known_hosts: "nav.known_hosts",
  cloud: "mobile.more.account",
  settings: "nav.settings",
};

/** Back, after whatever is open on top has closed. */
function stepBack(): boolean {
  const ui = useUi.getState();
  const tab = ui.tabs.find((each) => each.id === ui.active);
  if (tab) {
    // What is over the terminal goes first, then the terminal itself.
    if (tab.editor) requestCloseEditor(tab.id);
    else if (tab.files) ui.patchTab(tab.id, { files: false });
    else if (tab.side) ui.patchTab(tab.id, { side: null });
    else if (tab.searchOpen) ui.patchTab(tab.id, { searchOpen: false });
    else ui.goHome();
    return true;
  }
  if (ui.active !== "home") {
    if (ui.active === "new") ui.closeNewTab();
    ui.goHome();
    return true;
  }
  if (ui.hostPanel) {
    ui.setHostPanel(null);
    return true;
  }
  if (UNDER_MORE.includes(ui.view)) {
    ui.setView("more");
    return true;
  }
  if (ui.view !== "hosts") {
    ui.setView("hosts");
    return true;
  }
  return false;
}

function HomeHeader() {
  const t = useT();
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const under = UNDER_MORE.includes(view);
  return (
    <header className="m-bar">
      {under && (
        <button className="m-bar-icon" aria-label={t("mobile.back")} onClick={() => setView("more")}>
          <ArrowLeft size={20} />
        </button>
      )}
      <h1 className={cx("m-bar-heading", under && "with-back")}>{t(TITLES[view])}</h1>
      <AccountMenu />
    </header>
  );
}

function BottomNav() {
  const t = useT();
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const sessions = useUi((s) => s.tabs.length + s.guests.length);
  const current = UNDER_MORE.includes(view) ? "more" : view;
  return (
    <nav className="m-nav">
      {TABS.map(({ view: target, label, icon: Icon }) => (
        <button
          key={target}
          className={cx("m-nav-item", current === target && "active")}
          onClick={() => setView(target)}
        >
          <span className="m-nav-icon">
            <Icon size={21} strokeWidth={current === target ? 2.2 : 1.8} />
            {target === "sessions" && sessions > 0 && <span className="m-nav-badge">{sessions}</span>}
          </span>
          <span className="m-nav-label">{t(label)}</span>
        </button>
      ))}
    </nav>
  );
}

function MoreRow(props: { icon: ReactNode; label: string; detail?: string; onClick: () => void }) {
  return (
    <button className="m-row" onClick={props.onClick}>
      <span className="m-row-icon">{props.icon}</span>
      <span className="m-row-main">
        <span className="m-row-title">{props.label}</span>
        {props.detail && <span className="m-row-sub">{props.detail}</span>}
      </span>
      <ChevronRight size={18} className="m-row-chevron" />
    </button>
  );
}

/** What does not fit along the bottom. */
function MoreView() {
  const t = useT();
  const setView = useUi((s) => s.setView);
  const version = useVault((s) => s.status?.version);
  const cloud = useVault((s) => s.status?.cloud_available ?? false);
  const account = useVault((s) => s.snapshot.cloud?.email);
  const forwards = useVault((s) => s.snapshot.hosts.reduce((n, h) => n + h.forwards.length, 0));
  return (
    <div className="page m-more">
      <div className="page-body scroll">
        <div className="m-group">
          <MoreRow
            icon={<Cable size={19} />}
            label={t("nav.forwards")}
            detail={forwards > 0 ? String(forwards) : undefined}
            onClick={() => setView("forwards")}
          />
          <MoreRow icon={<ShieldCheck size={19} />} label={t("nav.known_hosts")} onClick={() => setView("known_hosts")} />
        </div>
        <div className="m-group">
          {cloud && account && (
            <MoreRow icon={<Cloud size={19} />} label={t("mobile.more.account")} detail={account} onClick={() => setView("cloud")} />
          )}
          <MoreRow icon={<SettingsIcon size={19} />} label={t("nav.settings")} onClick={() => setView("settings")} />
        </div>
        {version && <div className="m-version">MySSH {version}</div>}
      </div>
    </div>
  );
}

function HomeContent() {
  const view = useUi((s) => s.view);
  return (
    <div className="content">
      {view === "hosts" && <HostsView />}
      {view === "keychain" && <KeychainView />}
      {view === "snippets" && <SnippetsView />}
      {view === "sessions" && <SessionsView />}
      {view === "more" && <MoreView />}
      {view === "forwards" && <ForwardsView />}
      {view === "known_hosts" && <KnownHostsView />}
      {view === "cloud" && <CloudView />}
      {view === "settings" && <SettingsView />}
    </div>
  );
}

export function MobileApp() {
  const loaded = useVault((s) => s.loaded);
  const failed = useVault((s) => s.loadError !== null);
  const tabs = useUi((s) => s.tabs);
  const guests = useUi((s) => s.guests);
  const active = useUi((s) => s.active);
  const signedOut = useVault((s) => (s.status?.cloud_available ?? false) && s.snapshot.cloud === null);
  const welcomed = useSettings((s) => s.welcomed);
  const setup = !useSettings((s) => s.setupDone);
  const welcome = signedOut && !welcomed;
  const activeTab = tabs.find((tab) => tab.id === active) ?? null;
  const activeGuest = guests.find((guest) => guest.id === active) ?? null;
  const onTerminal = activeTab !== null || activeGuest !== null;
  const firstRun = !onTerminal && (setup || welcome);
  const body = useRef<HTMLDivElement>(null);
  const [switcher, setSwitcher] = useState(false);

  useEffect(() => setBackFallback(stepBack), []);
  usePinchZoom(body, onTerminal);
  useTouchScroll(body, activeTab?.id ?? null);

  // The new-tab page of a computer is the list of hosts here.
  useEffect(() => {
    if (active === "new") {
      const ui = useUi.getState();
      ui.closeNewTab();
      ui.goHome("hosts");
    }
  }, [active]);

  // A terminal shown again gets the keys back: what was typed goes to it.
  useEffect(() => {
    if (activeTab) getSession(activeTab.id)?.refit();
  }, [activeTab?.id]);

  if (!loaded) return <div className="app mobile" />;

  return (
    <div className={cx("app mobile", onTerminal && "on-terminal", firstRun && "first-run")}>
      {failed ? (
        <div className="body">
          <VaultError />
        </div>
      ) : (
        <>
          {activeTab ? (
            <TermBar tab={activeTab} onSwitch={() => setSwitcher(true)} />
          ) : activeGuest ? (
            <GuestBar guest={activeGuest} onSwitch={() => setSwitcher(true)} />
          ) : (
            !firstRun && <HomeHeader />
          )}
          <div className="body" ref={body}>
            {!onTerminal && (setup ? <Setup /> : welcome ? <Welcome /> : <HomeContent />)}
            {tabs.map((tab) => (
              <TerminalPane key={tab.id} tab={tab} active={active === tab.id} />
            ))}
            {guests.map((guest) => (
              <GuestPane key={guest.id} guest={guest} active={active === guest.id} />
            ))}
          </div>
          {activeTab ? <ExtraKeys tab={activeTab} /> : !onTerminal && !firstRun && <BottomNav />}
          {switcher && <SessionSheet onClose={() => setSwitcher(false)} />}
        </>
      )}
      <LinkSheet />
      <SharingOffDialog />
      <ChangeEmailDialog />
      <Toasts />
    </div>
  );
}
