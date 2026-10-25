import { Check, Folder, Minus, Play, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useBack } from "../../lib/back";
import { reportError } from "../../lib/actions";
import { api, type Group, type HostView, type Id, type Snippet } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { openHost } from "../../lib/sessions";
import { compareHosts, hostSubtitle, hostTitle, useUi, useVault } from "../../lib/store";
import { OsIcon } from "../hosts/OsIcon";
import { cx, Switch } from "../ui";

/** Every host in a group and in the groups inside it. */
function hostsUnder(groupId: Id, groups: Group[], hosts: HostView[]): Id[] {
  const inside = new Set<Id>([groupId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const group of groups) {
      if (group.parent_id && inside.has(group.parent_id) && !inside.has(group.id)) {
        inside.add(group.id);
        grew = true;
      }
    }
  }
  return hosts.filter((h) => h.group_id && inside.has(h.group_id)).map((h) => h.id);
}

function Tick({ state }: { state: "all" | "some" | "none" }) {
  return (
    <span className={cx("tick", state)} aria-hidden>
      {state === "all" ? <Check size={12} strokeWidth={3} /> : state === "some" ? <Minus size={12} strokeWidth={3} /> : null}
    </span>
  );
}

/**
 * Runs a snippet on several hosts at once: pick them, by host or by group,
 * and each opens in a tab of its own and runs the snippet once signed in.
 * The choice can be remembered with the snippet for next time.
 */
export function RunPanel({ snippet, onClose }: { snippet: Snippet; onClose: () => void }) {
  const t = useT();
  useBack(onClose);
  const snapshot = useVault((s) => s.snapshot);
  const hosts = useMemo(() => [...snapshot.hosts].sort(compareHosts), [snapshot.hosts]);
  const groups = useMemo(
    () => snapshot.groups.filter((g) => hostsUnder(g.id, snapshot.groups, snapshot.hosts).length > 0),
    [snapshot.groups, snapshot.hosts],
  );
  const known = new Set(hosts.map((h) => h.id));
  const [picked, setPicked] = useState<Set<Id>>(() => new Set((snippet.targets ?? []).filter((id) => known.has(id))));
  const [remember, setRemember] = useState((snippet.targets ?? []).length > 0);
  const [query, setQuery] = useState("");

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((word) => text.toLowerCase().includes(word));
  const shownHosts = hosts.filter((h) => matches(`${hostTitle(h)} ${hostSubtitle(h, snapshot)} ${h.tags.join(" ")}`));
  const shownGroups = groups.filter((g) => matches(g.name));

  const toggle = (ids: Id[], on: boolean) =>
    setPicked((before) => {
      const next = new Set(before);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const stateOf = (ids: Id[]) => {
    const count = ids.filter((id) => picked.has(id)).length;
    return count === 0 ? "none" : count === ids.length ? "all" : "some";
  };

  const run = async () => {
    const targets = hosts.filter((h) => picked.has(h.id)).map((h) => h.id);
    if (targets.length === 0) return;
    const remembered = snippet.targets ?? [];
    const wanted = remember ? targets : [];
    if (wanted.join() !== remembered.join()) {
      await api.snippetTargets(snippet.id, wanted).catch(reportError);
    }
    // On several hosts the terminals share one tab, with a list of them at its side.
    const group = targets.length > 1 ? { id: `run-${Date.now()}`, title: snippet.name } : null;
    for (const hostId of targets) openHost(hostId, snippet.script, group);
    if (group) {
      const first = useUi.getState().tabs.find((tab) => tab.group?.id === group.id);
      if (first) useUi.getState().activate(first.id);
    }
    onClose();
  };

  return (
    <aside className="panel run-panel">
      <div className="panel-head">
        <div className="run-head">
          <h2>{t("run.title")}</h2>
          <div className="run-snippet" title={snippet.script}>
            {snippet.name}
          </div>
        </div>
        <button className="btn ghost icon small" title={t("common.close")} onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="panel-body">
        <div className="search">
          <Search size={15} />
          <input
            className="input"
            autoFocus
            value={query}
            placeholder={t("run.search")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (query ? setQuery("") : onClose())}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <div className="run-list scroll">
          {shownGroups.length > 0 && <div className="section-title">{t("run.groups")}</div>}
          {shownGroups.map((group) => {
            const ids = hostsUnder(group.id, snapshot.groups, snapshot.hosts);
            const state = stateOf(ids);
            return (
              <button
                key={group.id}
                type="button"
                className={cx("run-row", state !== "none" && "on")}
                onClick={() => toggle(ids, state !== "all")}
              >
                <Tick state={state} />
                <span className="card-icon accent small">
                  <Folder size={15} />
                </span>
                <span className="run-text">
                  <b>{group.name}</b>
                  <small>{t("run.group_hosts", { n: ids.length })}</small>
                </span>
              </button>
            );
          })}
          {shownHosts.length > 0 && <div className="section-title">{t("run.hosts")}</div>}
          {shownHosts.map((host) => {
            const on = picked.has(host.id);
            return (
              <button
                key={host.id}
                type="button"
                className={cx("run-row", on && "on")}
                onClick={() => toggle([host.id], !on)}
              >
                <Tick state={on ? "all" : "none"} />
                <span className="card-icon small">
                  <OsIcon os={host.os} />
                </span>
                <span className="run-text">
                  <b>{hostTitle(host)}</b>
                  <small>{hostSubtitle(host, snapshot)}</small>
                </span>
              </button>
            );
          })}
          {shownHosts.length === 0 && shownGroups.length === 0 && <p className="dim">{t("run.none")}</p>}
        </div>
      </div>
      <div className="panel-foot run-foot">
        <label className="run-remember">
          <span>{t("run.remember")}</span>
          <Switch on={remember} onChange={setRemember} />
        </label>
        <button className="btn primary" disabled={picked.size === 0} onClick={() => void run()}>
          <Play size={13} />
          {picked.size > 0 ? t("run.go_n", { n: picked.size }) : t("run.go")}
        </button>
      </div>
    </aside>
  );
}
