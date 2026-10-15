import { ChevronRight, Folder, History, Plus, Search, Server, Users } from "lucide-react";
import { useMemo, useState } from "react";
import type { Group, HostView, Id } from "../../lib/api";
import { formatAgo, useT } from "../../lib/i18n";
import { useRecent } from "../../lib/recent";
import { openHost } from "../../lib/sessions";
import { useSettings } from "../../lib/settings";
import { compareHosts, hostSubtitle, hostTitle, useUi, useVault } from "../../lib/store";
import { cx, Empty } from "../ui";
import { JoinDialog } from "../terminal/GuestPane";
import { matchesHost } from "./HostsView";
import { OsIcon } from "./OsIcon";

/**
 * What a new tab shows until a host is chosen: the hosts connected to most
 * recently, then all hosts by group, with a search over both. One click
 * connects, and the session takes this tab's place.
 */
export function NewTab() {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  const sharing = useSettings((s) => s.sharing);
  const snapshot = useVault((s) => s.snapshot);
  const recent = useRecent((s) => s.entries);
  const [query, setQuery] = useState("");
  const [groupId, setGroupId] = useState<Id | null>(null);
  /** A group picked with one click; two go into it, as into a folder. */
  const [pickedGroup, setPickedGroup] = useState<Id | null>(null);
  const [joining, setJoining] = useState(false);

  const connect = (host: HostView) => {
    openHost(host.id);
    useUi.getState().closeNewTab();
  };

  const group = snapshot.groups.find((g) => g.id === groupId) ?? null;
  const path = useMemo(() => {
    const trail: Group[] = [];
    let cursor = group;
    while (cursor) {
      trail.unshift(cursor);
      const parent = cursor.parent_id;
      cursor = snapshot.groups.find((g) => g.id === parent) ?? null;
    }
    return trail;
  }, [group, snapshot.groups]);

  const searching = query.trim() !== "";
  const found = searching
    ? snapshot.hosts.filter((h) => matchesHost(h, hostSubtitle(h, snapshot), query)).sort(compareHosts)
    : [];
  const recentHosts = recent.flatMap((entry) => {
    const host = snapshot.hosts.find((h) => h.id === entry.hostId);
    return host ? [{ host, at: entry.at }] : [];
  });
  const groups = snapshot.groups
    .filter((g) => g.parent_id === (group?.id ?? null))
    .sort((a, b) => a.name.localeCompare(b.name));
  const hosts = snapshot.hosts.filter((h) => h.group_id === (group?.id ?? null)).sort(compareHosts);
  const hostsUnder = (id: Id): number =>
    snapshot.hosts.filter((h) => h.group_id === id).length +
    snapshot.groups.filter((g) => g.parent_id === id).reduce((sum, g) => sum + hostsUnder(g.id), 0);

  const card = (host: HostView, at?: number) => (
    <button key={host.id} className="card" onClick={() => connect(host)}>
      <span className="card-icon" title={host.os?.name}>
        <OsIcon os={host.os} />
      </span>
      <span className="card-main">
        <span className="card-title">{hostTitle(host)}</span>
        <span className="card-sub">{hostSubtitle(host, snapshot)}</span>
        {at !== undefined ? (
          <span className="card-sub card-os">{formatAgo(at, locale)}</span>
        ) : (
          host.os && <span className="card-sub card-os">{host.os.name}</span>
        )}
      </span>
    </button>
  );

  return (
    <div className="page newtab">
      <div className="page-head">
        <div className="search">
          <Search size={15} />
          <input
            className="input"
            autoFocus
            value={query}
            placeholder={t("hosts.search")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // First clear the search, then give the tab up.
                if (query) setQuery("");
                else useUi.getState().closeNewTab();
              }
              // Enter takes the first match.
              if (e.key === "Enter" && found.length > 0) connect(found[0]);
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <div className="grow" />
        {sharing && (
          <button className="btn" onClick={() => setJoining(true)}>
            <Users size={15} />
            {t("join.button")}
          </button>
        )}
      </div>
      {joining && (
        <JoinDialog
          onClose={() => {
            setJoining(false);
            // Joined: the session's tab is showing, and this page has done its job.
            if (useUi.getState().active !== "new") useUi.getState().closeNewTab();
          }}
        />
      )}

      <div className="page-body scroll">
        {snapshot.hosts.length === 0 ? (
          <Empty
            icon={<Server size={24} />}
            title={t("hosts.empty.title")}
            text={t("hosts.empty.text")}
            action={
              <button
                className="btn primary"
                onClick={() => {
                  const ui = useUi.getState();
                  ui.setHostPanel({ mode: "new", groupId: null });
                  ui.closeNewTab();
                  ui.goHome("hosts");
                }}
              >
                <Plus size={15} />
                {t("hosts.new")}
              </button>
            }
          />
        ) : searching ? (
          found.length === 0 ? (
            <Empty icon={<Server size={24} />} text={t("hosts.no_results", { query: query.trim() })} />
          ) : (
            <>
              <div className="section-title">
                {t("hosts.section")}
                <span className="dim">{found.length}</span>
              </div>
              <div className="grid">{found.map((host) => card(host))}</div>
            </>
          )
        ) : (
          <>
            {recentHosts.length > 0 && (
              <>
                <div className="section-title">
                  <History size={13} />
                  {t("newtab.recent")}
                </div>
                <div className="grid">{recentHosts.map(({ host, at }) => card(host, at))}</div>
              </>
            )}

            <div className="section-title">{t("hosts.section")}</div>
            {snapshot.groups.length > 0 && (
              <div className="crumbs">
                <button className={cx(!group && "current")} onClick={() => setGroupId(null)}>
                  {t("hosts.all")}
                </button>
                {path.map((g) => (
                  <span key={g.id} style={{ display: "contents" }}>
                    <ChevronRight size={13} />
                    <button className={cx(g.id === group?.id && "current")} onClick={() => setGroupId(g.id)}>
                      {g.name}
                    </button>
                  </span>
                ))}
              </div>
            )}
            {groups.length > 0 && (
              <div className="grid newtab-groups">
                {groups.map((g) => (
                  <button
                    key={g.id}
                    className={cx("card", pickedGroup === g.id && "selected")}
                    onClick={() => setPickedGroup(g.id)}
                    onDoubleClick={() => {
                      setPickedGroup(null);
                      setGroupId(g.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        setPickedGroup(null);
                        setGroupId(g.id);
                      }
                    }}
                  >
                    <span className="card-icon accent">
                      <Folder size={18} />
                    </span>
                    <span className="card-main">
                      <span className="card-title">{g.name}</span>
                      <span className="card-sub">{t("hosts.count", { n: hostsUnder(g.id) })}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {hosts.length > 0 ? (
              <div className="grid">{hosts.map((host) => card(host))}</div>
            ) : (
              groups.length === 0 && <Empty icon={<Server size={24} />} text={t("hosts.empty.group")} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
