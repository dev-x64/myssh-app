// The terminals open on a phone: one under another, each going on while
// another is looked at. The same list comes up from a terminal's title, to
// go to another without going back.

import { Layers, Plus, Users, X } from "lucide-react";
import { useT, type MessageKey } from "../../lib/i18n";
import { leaveShare } from "../../lib/guest";
import { requestCloseTab } from "../../lib/sessions";
import { hostSubtitle, isLocalTab, useUi, useVault, type Tab } from "../../lib/store";
import { cx, Empty, Sheet } from "../ui";

/** What a tab is doing, in a few words under its name. */
export function useTabDetail(tab: Tab): string {
  const t = useT();
  const host = useVault((s) => s.snapshot.hosts.find((h) => h.id === tab.hostId));
  const snapshot = useVault((s) => s.snapshot);
  if (tab.status === "connecting") {
    return t(`term.stage.${tab.stage ?? "connecting"}` as MessageKey, { host: host?.address ?? tab.title });
  }
  if (tab.status === "closed") {
    return t(tab.closed?.reason === "lost" ? "term.closed.lost" : tab.closed?.reason === "failed" ? "term.closed.failed" : "term.closed.exited");
  }
  if (isLocalTab(tab) || !host) return "";
  return hostSubtitle(host, snapshot);
}

function TabRow({ tab, onPick }: { tab: Tab; onPick: () => void }) {
  const t = useT();
  const active = useUi((s) => s.active === tab.id);
  const detail = useTabDetail(tab);
  return (
    <div className={cx("m-session", active && "active")}>
      <button className="m-session-main" onClick={onPick}>
        <span className={cx("dot", tab.status, tab.checking && "checking", tab.reconnect && "waiting")} />
        <span className="m-session-text">
          <span className="m-session-title">
            {tab.title}
            {tab.group && <span className="m-session-group">{tab.group.title}</span>}
          </span>
          {detail && <span className="m-session-sub">{detail}</span>}
        </span>
      </button>
      <button className="m-session-close" aria-label={t("tab.close")} onClick={() => requestCloseTab(tab.id)}>
        <X size={18} />
      </button>
    </div>
  );
}

/** Every open terminal, and the shared ones of others; a tap goes to one. */
function SessionRows({ onPick }: { onPick?: () => void }) {
  const t = useT();
  const tabs = useUi((s) => s.tabs);
  const guests = useUi((s) => s.guests);
  const activeId = useUi((s) => s.active);
  const activate = useUi((s) => s.activate);
  const go = (id: string) => {
    activate(id);
    onPick?.();
  };
  return (
    <div className="m-sessions">
      {tabs.map((tab) => (
        <TabRow key={tab.id} tab={tab} onPick={() => go(tab.id)} />
      ))}
      {guests.map((guest) => (
        <div key={guest.id} className={cx("m-session", activeId === guest.id && "active")}>
          <button className="m-session-main" onClick={() => go(guest.id)}>
            <Users size={16} className="m-session-mark" />
            <span className="m-session-text">
              <span className="m-session-title">{guest.title || t("guest.tab")}</span>
              {guest.hostName && <span className="m-session-sub">{guest.hostName}</span>}
            </span>
          </button>
          <button className="m-session-close" aria-label={t("guest.leave")} onClick={() => leaveShare(guest.id)}>
            <X size={18} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function SessionsView() {
  const t = useT();
  const count = useUi((s) => s.tabs.length + s.guests.length);
  const goHome = useUi((s) => s.goHome);
  return (
    <div className="page">
      <div className="page-body scroll">
        {count === 0 ? (
          <Empty
            icon={<Layers size={24} />}
            title={t("mobile.sessions.empty.title")}
            text={t("mobile.sessions.empty.text")}
            action={
              <button className="btn primary" onClick={() => goHome("hosts")}>
                {t("mobile.sessions.to_hosts")}
              </button>
            }
          />
        ) : (
          <SessionRows />
        )}
      </div>
    </div>
  );
}

/** The list over a terminal, opened from its title. */
export function SessionSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Sheet title={t("mnav.sessions")} onClose={onClose}>
      <SessionRows onPick={onClose} />
      <button
        className="btn m-sheet-action"
        onClick={() => {
          onClose();
          useUi.getState().goHome("hosts");
        }}
      >
        <Plus size={17} />
        {t("mobile.sessions.new")}
      </button>
    </Sheet>
  );
}
