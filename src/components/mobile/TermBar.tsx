// The bar over a terminal on a phone: back to the list, the terminal's name
// (a tap on it lists the other sessions), its files, and the rest in a menu.

import {
  ArrowLeft,
  ChevronDown,
  FolderOpen,
  MoreVertical,
  Pencil,
  RotateCw,
  Search,
  Settings2,
  SquareTerminal,
  TextSelect,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { leaveShare } from "../../lib/guest";
import { getSession, requestCloseTab } from "../../lib/sessions";
import { isLocalTab, useUi, type GuestTab, type Tab } from "../../lib/store";
import { RenameTab } from "../RenameTab";
import { ForwardsButton } from "../terminal/ForwardsPanel";
import { ShareButton } from "../terminal/SharePanel";
import { ContextMenu, cx, type MenuEntry } from "../ui";
import { useTabDetail } from "./Sessions";
import { SelectText } from "./SelectText";

export function TermBar({ tab, onSwitch }: { tab: Tab; onSwitch: () => void }) {
  const t = useT();
  const patchTab = useUi((s) => s.patchTab);
  const detail = useTabDetail(tab);
  const local = isLocalTab(tab);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [selecting, setSelecting] = useState(false);

  const entries: MenuEntry[] = [
    {
      label: t("term.tools.find"),
      icon: <Search size={18} />,
      onSelect: () => patchTab(tab.id, { searchOpen: true }),
    },
    {
      label: t("term.tools.snippets"),
      icon: <SquareTerminal size={18} />,
      onSelect: () => patchTab(tab.id, { side: tab.side === "snippets" ? null : "snippets" }),
    },
    { label: t("mobile.term.select"), icon: <TextSelect size={18} />, onSelect: () => setSelecting(true) },
    { label: t("tab.rename"), icon: <Pencil size={18} />, onSelect: () => setRenaming(true) },
  ];
  if (tab.status === "closed" && !local) {
    entries.push({ label: t("tab.reconnect"), icon: <RotateCw size={18} />, onSelect: () => getSession(tab.id)?.reconnect() });
  }
  if (!local) {
    entries.push({
      label: t("tab.edit_host"),
      icon: <Settings2 size={18} />,
      onSelect: () => {
        const ui = useUi.getState();
        ui.goHome("hosts");
        ui.setHostPanel({ mode: "edit", hostId: tab.hostId, tabId: tab.id });
      },
    });
  }
  entries.push({
    label: t("tab.close"),
    icon: <X size={18} />,
    danger: true,
    separatorBefore: true,
    onSelect: () => requestCloseTab(tab.id),
  });

  return (
    <header className="m-bar term">
      <button className="m-bar-icon" aria-label={t("mobile.back")} onClick={() => useUi.getState().goHome()}>
        <ArrowLeft size={20} />
      </button>
      <button className="m-bar-title" onClick={onSwitch} aria-label={t("mnav.sessions")}>
        <span className="m-bar-name">
          <span className={cx("dot", tab.status, tab.checking && "checking", tab.reconnect && "waiting")} />
          <span className="m-bar-text">{tab.title}</span>
          <ChevronDown size={15} className="m-bar-chevron" />
        </span>
        {detail && <span className="m-bar-sub">{detail}</span>}
      </button>
      {!local && (
        <button
          className={cx("m-bar-icon", tab.files && "on")}
          aria-label={t("term.tools.files")}
          onClick={() => patchTab(tab.id, { files: !tab.files })}
        >
          <FolderOpen size={19} />
        </button>
      )}
      {!local && <ForwardsButton tab={tab} />}
      {!local && <ShareButton tab={tab} />}
      <button className="m-bar-icon" aria-label={t("mobile.term.menu")} onClick={() => setMenu(true)}>
        <MoreVertical size={19} />
      </button>
      {menu && <ContextMenu x={0} y={0} title={tab.title} entries={entries} onClose={() => setMenu(false)} />}
      {renaming && (
        <RenameTab
          tab={tab}
          onDone={(title) => {
            if (title) patchTab(tab.id, { title });
            setRenaming(false);
          }}
        />
      )}
      {selecting && <SelectText tab={tab} onClose={() => setSelecting(false)} />}
    </header>
  );
}

/** Over a terminal someone else shares: its name, and the way out of it. */
export function GuestBar({ guest, onSwitch }: { guest: GuestTab; onSwitch: () => void }) {
  const t = useT();
  return (
    <header className="m-bar term">
      <button className="m-bar-icon" aria-label={t("mobile.back")} onClick={() => useUi.getState().goHome()}>
        <ArrowLeft size={20} />
      </button>
      <button className="m-bar-title" onClick={onSwitch} aria-label={t("mnav.sessions")}>
        <span className="m-bar-name">
          <Users size={15} />
          <span className="m-bar-text">{guest.title || t("guest.tab")}</span>
          <ChevronDown size={15} className="m-bar-chevron" />
        </span>
        {guest.hostName && <span className="m-bar-sub">{guest.hostName}</span>}
      </button>
      <button className="m-bar-icon" aria-label={t("guest.leave")} onClick={() => leaveShare(guest.id)}>
        <X size={19} />
      </button>
    </header>
  );
}
