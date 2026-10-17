import { Folder, History, Plus, Search, Server, Terminal as TerminalIcon, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HostView } from "../../lib/api";
import { formatAgo, useT } from "../../lib/i18n";
import { useRecent } from "../../lib/recent";
import { openHost, openLocal } from "../../lib/sessions";
import { useSettings } from "../../lib/settings";
import { compareHosts, hostSubtitle, hostTitle, useUi, useVault } from "../../lib/store";
import { cx, Empty } from "../ui";
import { JoinDialog } from "../terminal/GuestPane";
import { groupOptions } from "./HostPanel";
import { matchesHost } from "./HostsView";
import { OsIcon } from "./OsIcon";

/** How many of the hosts connected to most recently are offered first. */
const RECENT_SHOWN = 5;

/**
 * What a new tab shows until a host is chosen: the hosts connected to most
 * recently, then every host in sections by group, with a search over all.
 * The arrows go from host to host and Enter connects; so does one click,
 * and the session takes this tab's place.
 */
export function NewTab() {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  const sharing = useSettings((s) => s.sharing);
  const snapshot = useVault((s) => s.snapshot);
  const recent = useRecent((s) => s.entries);
  const [query, setQuery] = useState("");
  /** The host the arrows are on; Enter connects to it. */
  const [cursor, setCursor] = useState(0);
  const [joining, setJoining] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  const connect = (host: HostView) => {
    openHost(host.id);
    useUi.getState().closeNewTab();
  };
  const local = () => {
    openLocal();
    useUi.getState().closeNewTab();
  };

  const searching = query.trim() !== "";
  const found = searching
    ? snapshot.hosts.filter((h) => matchesHost(h, hostSubtitle(h, snapshot), query)).sort(compareHosts)
    : [];
  const recentHosts = recent
    .flatMap((entry) => {
      const host = snapshot.hosts.find((h) => h.id === entry.hostId);
      return host ? [{ host, at: entry.at }] : [];
    })
    .slice(0, RECENT_SHOWN);
  // Every host at once, in sections by group as on the hosts page: no
  // folder to open before the host can be seen.
  const sections = useMemo(() => {
    const paths = groupOptions(snapshot.groups);
    return [
      { id: "none", title: null as string | null, hosts: snapshot.hosts.filter((h) => !h.group_id).sort(compareHosts) },
      ...paths.map((g) => ({
        id: g.id,
        title: g.path,
        hosts: snapshot.hosts.filter((h) => h.group_id === g.id).sort(compareHosts),
      })),
    ].filter((section) => section.hosts.length > 0);
  }, [snapshot.hosts, snapshot.groups]);

  // The order the arrows go in: what is on screen, top to bottom.
  const order: HostView[] = searching
    ? found
    : [...recentHosts.map((r) => r.host), ...sections.flatMap((section) => section.hosts)];
  const at = Math.min(cursor, Math.max(order.length - 1, 0));

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    list.current?.querySelector(".card.selected")?.scrollIntoView({ block: "nearest" });
  }, [at]);

  // A card's place in the order, counting the recent ones first.
  let index = 0;
  const card = (host: HostView, ago?: number) => {
    const mine = index++;
    return (
      <button
        key={`${ago === undefined ? "h" : "r"}-${host.id}`}
        className={cx("card", mine === at && "selected")}
        onClick={() => connect(host)}
        onMouseEnter={() => setCursor(mine)}
      >
        <span className="card-icon" title={host.os?.name}>
          <OsIcon os={host.os} />
        </span>
        <span className="card-main">
          <span className="card-title">{hostTitle(host)}</span>
          <span className="card-sub">{hostSubtitle(host, snapshot)}</span>
          {ago !== undefined ? (
            <span className="card-sub card-os">{formatAgo(ago, locale)}</span>
          ) : (
            host.os && <span className="card-sub card-os">{host.os.name}</span>
          )}
        </span>
      </button>
    );
  };

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
              } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                e.preventDefault();
                setCursor(Math.min(at + 1, order.length - 1));
              } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                e.preventDefault();
                setCursor(Math.max(at - 1, 0));
              } else if (e.key === "Enter" && order[at]) {
                connect(order[at]);
              }
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <span className="newtab-keys dim">{t("newtab.keys")}</span>
        <div className="grow" />
        <button className="btn" onClick={local} title={t("newtab.local")}>
          <TerminalIcon size={15} />
          <span className="btn-label">{t("newtab.local")}</span>
        </button>
        {sharing && (
          <button className="btn" onClick={() => setJoining(true)}>
            <Users size={15} />
            <span className="btn-label">{t("join.button")}</span>
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

      <div className="page-body scroll" ref={list}>
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
                <div className="grid">{recentHosts.map(({ host, at: ago }) => card(host, ago))}</div>
              </>
            )}
            {sections.map((section) => (
              <div key={section.id} className="newtab-section">
                <div className="section-title">
                  {section.title ? (
                    <>
                      <Folder size={13} />
                      {section.title}
                    </>
                  ) : (
                    t(recentHosts.length > 0 || sections.length > 1 ? "newtab.ungrouped" : "hosts.section")
                  )}
                  <span className="dim">{section.hosts.length}</span>
                </div>
                <div className="grid">{section.hosts.map((host) => card(host))}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
