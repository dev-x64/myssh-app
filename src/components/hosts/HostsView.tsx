import {
  ChevronRight,
  Copy,
  Download,
  Folder,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  Search,
  Server,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { mutate } from "../../lib/actions";
import { api, type Group, type HostView, type Id } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { watchHosts } from "../../lib/hostStats";
import { openHost } from "../../lib/sessions";
import { dropTarget as takesDrops, startDrag as beginDrag, useDrag, type Payload } from "../../lib/drag";
import { MOBILE } from "../../lib/platform";
import { useSettings } from "../../lib/settings";
import { compareHosts, hostSubtitle, hostTitle, useUi, useVault } from "../../lib/store";
import { Confirm, ContextMenu, cx, Empty, type MenuEntry } from "../ui";
import { GroupDialog } from "./GroupDialog";
import { HostLoad, OnlineDot } from "./HostLoad";
import { HostPanel } from "./HostPanel";
import { ImportDialog } from "./ImportDialog";
import { KeyBadge } from "./KeyBadge";
import { TailscaleBadge } from "./TailscaleBadge";
import { watchTailscale } from "../../lib/tailscale";
import { Tip } from "../Tip";
import { keyOf } from "../../lib/shortcuts";
import { OsIcon } from "./OsIcon";

const HOST_DRAG = "host";
const GROUP_DRAG = "group";

type Dialog =
  | { kind: "group"; group: Group | null }
  | { kind: "delete-host"; host: HostView }
  | { kind: "delete-group"; group: Group }
  | { kind: "import" }
  | null;

/** Every word of the query is somewhere in what a host shows. */
export function matchesHost(host: HostView, subtitle: string, query: string): boolean {
  const haystack = [host.label, host.address, subtitle, host.os?.name ?? "", ...host.tags]
    .join("\n")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export function HostsView() {
  const t = useT();
  const snapshot = useVault((s) => s.snapshot);
  // Which of the hosts are online, as Tailscale sees it, for those of a tailnet.
  useEffect(() => watchTailscale(snapshot.hosts), [snapshot.hosts]);
  const panel = useUi((s) => s.hostPanel);
  const setPanel = useUi((s) => s.setHostPanel);

  const [groupId, setGroupId] = useState<Id | null>(null);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [selected, setSelected] = useState<Id | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; title?: string; entries: MenuEntry[] } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // The current group may have been deleted.
  const group = snapshot.groups.find((g) => g.id === groupId) ?? null;
  useEffect(() => {
    if (groupId && !group) setGroupId(null);
  }, [groupId, group]);

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

  /** Hosts in a group including everything nested below it. */
  const countIn = useMemo(() => {
    const children = new Map<Id | null, Id[]>();
    for (const g of snapshot.groups) {
      children.set(g.parent_id, [...(children.get(g.parent_id) ?? []), g.id]);
    }
    const direct = new Map<Id | null, number>();
    for (const h of snapshot.hosts) direct.set(h.group_id, (direct.get(h.group_id) ?? 0) + 1);
    const total = (id: Id): number =>
      (direct.get(id) ?? 0) + (children.get(id) ?? []).reduce((sum, child) => sum + total(child), 0);
    return total;
  }, [snapshot]);

  const allTags = useMemo(
    () => [...new Set(snapshot.hosts.flatMap((h) => h.tags))].sort((a, b) => a.localeCompare(b)),
    [snapshot.hosts],
  );
  useEffect(() => {
    if (tag && !allTags.includes(tag)) setTag(null);
  }, [tag, allTags]);

  const searching = query.trim() !== "" || tag !== null;
  const groups = searching
    ? []
    : snapshot.groups
        .filter((g) => g.parent_id === groupId)
        .sort((a, b) => a.name.localeCompare(b.name));
  const hosts = snapshot.hosts
    .filter((h) =>
      searching
        ? (!tag || h.tags.includes(tag)) && matchesHost(h, hostSubtitle(h, snapshot), query)
        : h.group_id === groupId,
    )
    .sort(compareHosts);

  // Advanced mode: the load of the hosts whose tiles are shown.
  const showLoad = useSettings((s) => s.serverStats && s.statsTiles);
  const shownIds = hosts.map((h) => h.id).join(",");
  useEffect(() => {
    if (!showLoad || !shownIds) return;
    return watchHosts(shownIds.split(","));
  }, [showLoad, shownIds]);

  /** The group card or breadcrumb a dragged item is over; `"root"` is "All hosts". */
  const over = useDrag((s) => s.over);
  const dropTarget = over?.startsWith("hosts:") ? (over.slice(6) as Id | "root") : null;

  const startDrag = (e: MouseEvent, type: typeof HOST_DRAG | typeof GROUP_DRAG, id: Id, label: string) =>
    beginDrag(e, { kind: type, data: id }, { label });

  /** Props that make an element accept hosts and groups dropped on it. */
  const dropInto = (target: Id | null) => {
    const accepts = (payload: Payload) => {
      if (payload.kind === HOST_DRAG) {
        return snapshot.hosts.find((h) => h.id === payload.data)?.group_id !== target;
      }
      if (payload.kind !== GROUP_DRAG || payload.data === target) return false;
      return snapshot.groups.find((g) => g.id === payload.data)?.parent_id !== target;
    };
    const drop = (payload: Payload) => {
      const id = payload.data as Id;
      const where = target ? (snapshot.groups.find((g) => g.id === target)?.name ?? "") : t("hosts.all");
      if (payload.kind === HOST_DRAG) {
        void mutate(() => api.hostMove(id, target), t("hosts.moved", { name: where }));
      } else {
        const moved = snapshot.groups.find((g) => g.id === id);
        if (!moved) return;
        void mutate(
          () => api.groupSave({ id: moved.id, name: moved.name, parent_id: target }),
          t("hosts.moved", { name: where }),
        );
      }
    };
    return { ref: takesDrops({ key: `hosts:${target ?? "root"}`, accepts, drop }) };
  };

  const duplicate = (host: HostView) =>
    mutate(() => api.hostDuplicate(host.id, t("hosts.copy_suffix")), t("hosts.duplicated"));

  const hostMenu = (e: MouseEvent, host: HostView) => {
    e.preventDefault();
    setSelected(host.id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      title: hostTitle(host),
      entries: [
        { label: t("common.connect"), icon: <Play size={14} />, onSelect: () => openHost(host.id) },
        {
          label: t("common.edit"),
          icon: <Pencil size={14} />,
          onSelect: () => setPanel({ mode: "edit", hostId: host.id }),
        },
        {
          label: t(host.pinned ? "hosts.unpin" : "hosts.pin"),
          icon: host.pinned ? <PinOff size={14} /> : <Pin size={14} />,
          onSelect: () => void mutate(() => api.hostPin(host.id, !host.pinned)),
        },
        { label: t("hosts.duplicate"), icon: <Copy size={14} />, onSelect: () => void duplicate(host) },
        {
          label: t("common.delete"),
          icon: <Trash2 size={14} />,
          danger: true,
          separatorBefore: true,
          onSelect: () => setDialog({ kind: "delete-host", host }),
        },
      ],
    });
  };

  const groupMenu = (e: MouseEvent, target: Group) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      title: target.name,
      entries: [
        {
          label: t("common.rename"),
          icon: <Pencil size={14} />,
          onSelect: () => setDialog({ kind: "group", group: target }),
        },
        {
          label: t("common.delete"),
          icon: <Trash2 size={14} />,
          danger: true,
          separatorBefore: true,
          onSelect: () => setDialog({ kind: "delete-group", group: target }),
        },
      ],
    });
  };

  const nothingAtAll = snapshot.hosts.length === 0 && snapshot.groups.length === 0;

  return (
    <>
      <div className="page">
        <div className="page-head">
          <div className="search">
            <Search size={15} />
            <input
              ref={searchRef}
              className="input"
              value={query}
              placeholder={t("hosts.search")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
                if (e.key === "Enter" && hosts.length === 1) openHost(hosts[0].id);
              }}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
          <div className="grow" />
          <button className="btn" title={t("import.button.hint")} onClick={() => setDialog({ kind: "import" })}>
            <Download size={15} />
            <span className="btn-label">{t("import.button")}</span>
          </button>
          <button className="btn" title={t("hosts.new_group")} onClick={() => setDialog({ kind: "group", group: null })}>
            <FolderPlus size={15} />
            <span className="btn-label">{t("hosts.new_group")}</span>
          </button>
          <button className="btn primary" onClick={() => setPanel({ mode: "new", groupId })}>
            <Plus size={15} />
            {t("hosts.new")}
          </button>
        </div>

        <div className="page-body scroll" onClick={() => setSelected(null)}>
          {snapshot.hosts.length > 0 && (
            <Tip id="hosts" title={t("tip.hosts.title")}>
              {t("tip.hosts.text", { newHost: keyOf("new_host"), newTab: keyOf("new_tab") })}
            </Tip>
          )}
          {!searching && (
            <div className="crumbs">
              <button
                className={cx(!group && "current", dropTarget === "root" && "dropping")}
                onClick={() => setGroupId(null)}
                {...dropInto(null)}
              >
                {t("hosts.all")}
              </button>
              {path.map((g) => (
                <span key={g.id} style={{ display: "contents" }}>
                  <ChevronRight size={13} />
                  <button
                    className={cx(g.id === groupId && "current", dropTarget === g.id && "dropping")}
                    onClick={() => setGroupId(g.id)}
                    {...dropInto(g.id)}
                  >
                    {g.name}
                  </button>
                </span>
              ))}
            </div>
          )}

          {allTags.length > 0 && (
            <div className="tag-filter">
              {allTags.map((name) => (
                <button
                  key={name}
                  className={cx("chip", tag === name && "active")}
                  onClick={() => setTag(tag === name ? null : name)}
                >
                  {name}
                </button>
              ))}
            </div>
          )}

          {groups.length > 0 && (
            <>
              <div className="section-title">{t("hosts.groups")}</div>
              <div className="grid">
                {groups.map((g) => (
                  <button
                    key={g.id}
                    className={cx("card", dropTarget === g.id && "dropping", selected === g.id && "selected")}
                    onMouseDown={(e) => startDrag(e, GROUP_DRAG, g.id, g.name)}
                    // As a folder: one click picks it, two (or Enter) go in. A tap goes in.
                    onClick={(e) => {
                      e.stopPropagation();
                      if (MOBILE) setGroupId(g.id);
                      else setSelected(g.id);
                    }}
                    onDoubleClick={() => {
                      setSelected(null);
                      setGroupId(g.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        setSelected(null);
                        setGroupId(g.id);
                      }
                    }}
                    onContextMenu={(e) => groupMenu(e, g)}
                    {...dropInto(g.id)}
                  >
                    <span className="card-icon accent">
                      <Folder size={18} />
                    </span>
                    <span className="card-main">
                      <span className="card-title" style={{ display: "block" }}>
                        {g.name}
                      </span>
                      <span className="card-sub" style={{ display: "block" }}>
                        {t("hosts.count", { n: countIn(g.id) })}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {hosts.length > 0 && (
            <>
              <div className="section-title">
                {t("hosts.section")}
                <span className="dim">{hosts.length}</span>
              </div>
              <div className="grid">
                {hosts.map((host) => (
                  <div
                    key={host.id}
                    role="button"
                    tabIndex={0}
                    className={cx(
                      "card",
                      showLoad && "with-load",
                      (selected === host.id || (panel?.mode === "edit" && panel.hostId === host.id)) &&
                        "selected",
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      // On a phone a tap connects, as a double click does here.
                      if (MOBILE) openHost(host.id);
                      else setSelected(host.id);
                    }}
                    onMouseDown={(e) => startDrag(e, HOST_DRAG, host.id, hostTitle(host))}
                    onDoubleClick={() => openHost(host.id)}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && e.key === "Enter") openHost(host.id);
                    }}
                    onContextMenu={(e) => hostMenu(e, host)}
                  >
                    <span className="card-icon" title={host.os?.name}>
                      <OsIcon os={host.os} />
                      {showLoad && <OnlineDot hostId={host.id} />}
                    </span>
                    <div className="card-main">
                      <div className="card-title">
                        {host.pinned && <Pin size={12} className="card-pin" aria-label={t("hosts.pinned")} />}
                        {hostTitle(host)}
                        <TailscaleBadge host={host} />
                      </div>
                      <div className="card-sub">
                        {hostSubtitle(host, snapshot)}
                        <KeyBadge host={host} />
                      </div>
                      {host.os && <div className="card-sub card-os">{host.os.name}</div>}
                      {host.tags.some((name) => name !== "tailscale") && (
                        <div className="card-tags">
                          {/* The Tailscale badge by the name says that one already. */}
                          {host.tags.filter((name) => name !== "tailscale").map((name) => (
                            <span key={name} className="chip">
                              {name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="card-actions">
                      <button
                        className="btn small icon"
                        title={t("common.edit")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPanel({ mode: "edit", hostId: host.id });
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        className="btn small primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          openHost(host.id);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <Play size={12} />
                        {t("common.connect")}
                      </button>
                    </div>
                    {showLoad && <HostLoad hostId={host.id} />}
                  </div>
                ))}
              </div>
            </>
          )}

          {hosts.length === 0 && groups.length === 0 && (
            <Empty
              icon={<Server size={24} />}
              title={nothingAtAll ? t("hosts.empty.title") : undefined}
              text={
                nothingAtAll
                  ? t("hosts.empty.text")
                  : searching
                    ? t("hosts.no_results", { query: query.trim() || tag || "" })
                    : t("hosts.empty.group")
              }
              action={
                !searching && (
                  <div className="empty-actions">
                    <button className="btn primary" onClick={() => setPanel({ mode: "new", groupId })}>
                      <Plus size={15} />
                      {t("hosts.new")}
                    </button>
                    {nothingAtAll && (
                      <button className="btn" onClick={() => setDialog({ kind: "import" })}>
                        <Download size={15} />
                        {t("import.empty_action")}
                      </button>
                    )}
                  </div>
                )
              }
            />
          )}
        </div>
      </div>

      {panel && (
        <HostPanel
          key={panel.mode === "edit" ? panel.hostId : `new-${panel.groupId}`}
          panel={panel}
          onClose={() => setPanel(null)}
          onDelete={(host) => setDialog({ kind: "delete-host", host })}
        />
      )}

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}

      {dialog?.kind === "import" && <ImportDialog onClose={() => setDialog(null)} />}

      {dialog?.kind === "group" && (
        <GroupDialog group={dialog.group} parentId={groupId} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete-host" && (
        <Confirm
          danger
          title={t("hosts.delete.title")}
          text={t("hosts.delete.text", { name: hostTitle(dialog.host) })}
          confirmLabel={t("common.delete")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const host = dialog.host;
            setDialog(null);
            if (panel?.mode === "edit" && panel.hostId === host.id) setPanel(null);
            await mutate(() => api.hostDelete(host.id), t("hosts.deleted"));
          }}
        />
      )}
      {dialog?.kind === "delete-group" && (
        <Confirm
          danger
          title={t("group.delete.title")}
          text={t("group.delete.text", { name: dialog.group.name })}
          confirmLabel={t("common.delete")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const target = dialog.group;
            setDialog(null);
            await mutate(() => api.groupDelete(target.id));
          }}
        />
      )}
    </>
  );
}
