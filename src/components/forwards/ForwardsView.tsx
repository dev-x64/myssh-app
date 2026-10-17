import { ArrowLeft, ArrowRight, Cable, ChevronRight, Database, Laptop, Lock, Pencil, Play, Plus, Search, Server, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { mutate } from "../../lib/actions";
import { api, type HostView, type Id, type PortForward, type PortForwardInput } from "../../lib/api";
import { closeForward, openForward, refreshForwards, useForwards, type OpenForward } from "../../lib/forwards";
import { errorText, useT, type T } from "../../lib/i18n";
import { LINUX } from "../../lib/platform";
import { openHost } from "../../lib/sessions";
import { groupOptions, HostPanel } from "../hosts/HostPanel";
import { OsIcon } from "../hosts/OsIcon";
import { compareHosts, hostSubtitle, hostTitle, useUi, useVault, type Tab } from "../../lib/store";
import { cx, Empty } from "../ui";

/** How often the page asks how the open forwards are doing. */
const REFRESH_MS = 2000;

/** The services the helper knows, by the port they listen on. */
const SERVICES: { name: string; port: number }[] = [
  { name: "PostgreSQL", port: 5432 },
  { name: "MySQL", port: 3306 },
  { name: "Redis", port: 6379 },
  { name: "MongoDB", port: 27017 },
  { name: "ClickHouse", port: 8123 },
  { name: "Elasticsearch", port: 9200 },
  { name: "RabbitMQ", port: 15672 },
  { name: "Grafana", port: 3000 },
  { name: "Prometheus", port: 9090 },
  { name: "HTTP", port: 80 },
  { name: "HTTP 8080", port: 8080 },
];

interface Entry {
  host: HostView;
  forward: PortForward;
}

const targetOf = (f: Pick<PortForward, "remote_host" | "remote_port">) => `${f.remote_host}:${f.remote_port}`;
const itself = (host: string) => ["localhost", "127.0.0.1", "::1"].includes(host.trim().toLowerCase());

/** The tab a forward is asked for in, if any: the one to look at for how it is doing. */
function tabOf(tabs: Tab[], wanted: Record<string, { wanted: Id[] }>, entry: Entry): Tab | undefined {
  return tabs.find((tab) => tab.hostId === entry.host.id && wanted[tab.id]?.wanted.includes(entry.forward.id));
}

/**
 * Opens a forward from this page: on a tab of its host that is connected
 * or connecting, or else on a new one, opened behind this page. The
 * forward rides on that tab's connection.
 */
function startForward(entry: Entry) {
  const ui = useUi.getState();
  const tabs = ui.tabs.filter((tab) => tab.hostId === entry.host.id && !tab.group);
  const tab = tabs.find((t) => t.status === "connected") ?? tabs.find((t) => t.status === "connecting");
  if (tab) {
    void openForward(tab.id, entry.forward);
    return;
  }
  const here = ui.active;
  const opened = openHost(entry.host.id);
  if (!opened) return;
  void openForward(opened, entry.forward);
  useUi.getState().activate(here);
}

function stopForward(entry: Entry) {
  const { tabs } = useForwards.getState();
  for (const [tabId, state] of Object.entries(tabs)) {
    if (state.wanted.includes(entry.forward.id)) closeForward(tabId, entry.forward.id);
  }
}

/** The section of all forwards, of every host: each with how it is doing, opened and stopped here. */
export function ForwardsView() {
  const t = useT();
  const hosts = useVault((s) => s.snapshot.hosts);
  const tabs = useUi((s) => s.tabs);
  const forwardTabs = useForwards((s) => s.tabs);
  const [query, setQuery] = useState("");
  /** The forward in the editor: `new`, or one by its id. */
  const [editing, setEditing] = useState<Id | "new" | null>(null);
  /** A new host being made from the editor, and where to say which it is. */
  const [hostForm, setHostForm] = useState<{ done: (id: Id) => void } | null>(null);

  const entries = useMemo<Entry[]>(
    () =>
      hosts
        .flatMap((host) => host.forwards.map((forward) => ({ host, forward })))
        .sort((a, b) => a.forward.local_port - b.forward.local_port),
    [hosts],
  );
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? entries.filter(({ host, forward }) =>
        [forward.label, String(forward.local_port), targetOf(forward), hostTitle(host), host.address].some((text) =>
          text.toLowerCase().includes(needle),
        ),
      )
    : entries;

  // While the page is open, what the open forwards are doing is asked now and then.
  const live = Object.entries(forwardTabs)
    .filter(([, state]) => Object.keys(state.open).length > 0)
    .map(([tabId]) => tabId)
    .join(",");
  useEffect(() => {
    if (!live) return;
    const ask = () => live.split(",").forEach((tabId) => void refreshForwards(tabId));
    ask();
    const timer = window.setInterval(ask, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [live]);

  const current = editing && editing !== "new" ? entries.find((e) => e.forward.id === editing) : undefined;

  return (
    <>
      <div className="page">
        <div className="page-head">
          <div className="search">
            <Search size={15} />
            <input
              className="input"
              value={query}
              placeholder={t("fwd.search")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              spellCheck={false}
            />
          </div>
          <div className="grow" />
          <button className="btn primary" onClick={() => setEditing("new")}>
            <Plus size={15} />
            {t("fwd.new")}
          </button>
        </div>

        <div className="page-body scroll">
          {shown.length > 0 && (
            <>
              <div className="section-title">
                {t("fwd.title")}
                <span className="dim">{shown.length}</span>
              </div>
              <div className="grid">
                {shown.map((entry) => {
                  const tab = tabOf(tabs, forwardTabs, entry);
                  const state = tab ? forwardTabs[tab.id]?.open[entry.forward.id] : undefined;
                  const up = state?.state === "open";
                  return (
                    <div
                      key={entry.forward.id}
                      role="button"
                      tabIndex={0}
                      className={cx("card fwd-card", editing === entry.forward.id && "selected")}
                      onDoubleClick={() => (tab ? stopForward(entry) : startForward(entry))}
                      onKeyDown={(e) => e.target === e.currentTarget && e.key === "Enter" && setEditing(entry.forward.id)}
                    >
                      <span className={cx("card-icon fwd-icon", up && "up")}>
                        <Cable size={18} />
                      </span>
                      <div className="card-main">
                        <div className="card-title">
                          {entry.forward.label || `localhost:${entry.forward.local_port}`}
                          {entry.forward.auto && <span className="chip">{t("fwd.auto_chip")}</span>}
                        </div>
                        <div className="card-sub fwd-route">
                          :{entry.forward.local_port}
                          <ArrowRight size={11} />
                          {targetOf(entry.forward)}
                        </div>
                        <div className="card-sub">{t("fwd.via", { host: hostTitle(entry.host) })}</div>
                        <CardState t={t} entry={entry} tab={tab} state={state} />
                      </div>
                      <div className="card-actions">
                        <button
                          className="btn small icon"
                          title={t("common.edit")}
                          onClick={() => setEditing(entry.forward.id)}
                          onDoubleClick={(e) => e.stopPropagation()}
                        >
                          <Pencil size={13} />
                        </button>
                        {tab ? (
                          <button className="btn small" onClick={() => stopForward(entry)} onDoubleClick={(e) => e.stopPropagation()}>
                            <Square size={11} />
                            {t("fwd.stop")}
                          </button>
                        ) : (
                          <button
                            className="btn small primary"
                            onClick={() => startForward(entry)}
                            onDoubleClick={(e) => e.stopPropagation()}
                          >
                            <Play size={12} />
                            {t("fwd.start")}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {shown.length === 0 && (
            <Empty
              icon={<Cable size={24} />}
              title={entries.length === 0 ? t("fwd.title") : undefined}
              text={entries.length === 0 ? t("fwd.empty.text") : t("fwd.no_results", { query: query.trim() })}
              action={
                entries.length === 0 && (
                  <button className="btn primary" onClick={() => setEditing("new")}>
                    <Plus size={15} />
                    {t("fwd.new")}
                  </button>
                )
              }
            />
          )}
        </div>
      </div>

      {editing && (editing === "new" || current) && (
        <ForwardEditor
          key={editing}
          entry={current ?? null}
          hosts={hosts}
          entries={entries}
          hidden={hostForm !== null}
          onAddHost={(done) => setHostForm({ done })}
          onClose={() => setEditing(null)}
        />
      )}
      {hostForm && (
        <HostPanel
          panel={{ mode: "new", groupId: null }}
          onClose={() => setHostForm(null)}
          onSaved={(host) => hostForm.done(host.id)}
          onDelete={() => {}}
        />
      )}
    </>
  );
}

/** How a forward is doing, as the tab it rides on says. */
function CardState(props: { t: T; entry: Entry; tab: Tab | undefined; state: OpenForward | undefined }) {
  const { t, entry, tab, state } = props;
  if (!tab) return null;
  const host = hostTitle(entry.host);
  const toTab = (
    <button className="link-button" onClick={() => useUi.getState().activate(tab.id)} onDoubleClick={(e) => e.stopPropagation()}>
      {t("fwd.to_tab")}
    </button>
  );
  if (tab.status === "connecting") {
    return tab.prompt ? (
      <div className="fwd-state warn">
        {t("fwd.state.asks", { host })} {toTab}
      </div>
    ) : (
      <div className="fwd-state dim">{t("fwd.state.connecting", { host })}</div>
    );
  }
  if (tab.status === "closed") {
    return (
      <div className="fwd-state dim">
        {t(tab.reconnect ? "fwd.state.reconnecting" : "fwd.state.disconnected")} {!tab.reconnect && toTab}
      </div>
    );
  }
  if (!state || state.state === "opening") return <div className="fwd-state dim">{t("fwd.state.opening")}</div>;
  if (state.state === "failed") {
    const error = state.error;
    return (
      <div className="fwd-state bad">
        {error?.code === "port_in_use" ? t("fwd.port_in_use") : error ? errorText(error) : t("fwd.state.failed")}
      </div>
    );
  }
  const failure = state.status?.failure;
  if (failure) {
    const key = ({ refused: "fwd.failure.refused", prohibited: "fwd.failure.prohibited", timeout: "fwd.failure.timeout", closed: "fwd.failure.closed", other: "fwd.failure.other" } as const)[failure.code];
    return <div className="fwd-state bad">{t(key, { target: targetOf(entry.forward) })}</div>;
  }
  const open = state.status?.open ?? 0;
  return <div className="fwd-state ok">{open > 0 ? t("fwd.state.carrying", { n: open }) : t("fwd.state.open")}</div>;
}

const portOf = (text: string): number | null => {
  const n = Number(text.trim());
  return /^\d+$/.test(text.trim()) && n >= 1 && n <= 65535 ? n : null;
};

/**
 * Adds or changes a forward: the host it goes through, where it leads and
 * the port here, drawn as it will work. The helper fills in a known
 * service's port.
 */
function ForwardEditor(props: {
  entry: Entry | null;
  hosts: HostView[];
  entries: Entry[];
  /** Kept, with what is typed, while a new host is being made beside it. */
  hidden: boolean;
  onAddHost: (done: (id: Id) => void) => void;
  onClose: () => void;
}) {
  const t = useT();
  const f = props.entry?.forward;
  // A new forward names no host until one is picked, unless there is only one.
  const [hostId, setHostId] = useState<Id | null>(
    props.entry?.host.id ?? (props.hosts.length === 1 ? props.hosts[0].id : null),
  );
  const [label, setLabel] = useState(f?.label ?? "");
  const [remoteHost, setRemoteHost] = useState(f?.remote_host ?? "localhost");
  const [remotePort, setRemotePort] = useState(f ? String(f.remote_port) : "");
  const [localPort, setLocalPort] = useState(f ? String(f.local_port) : "");
  // A new forward takes the same port here as there, until told otherwise.
  const [localTouched, setLocalTouched] = useState(f !== undefined);
  const [auto, setAuto] = useState(f?.auto ?? false);
  const [busy, setBusy] = useState(false);
  // Choosing the host takes the whole panel, as a list to search.
  const [picking, setPicking] = useState(false);
  const snapshot = useVault((s) => s.snapshot);

  const host = props.hosts.find((h) => h.id === hostId);
  const remote = portOf(remotePort);
  const local = portOf(localTouched ? localPort : remotePort);
  const others = props.entries.filter((e) => e.forward.id !== f?.id && e.forward.local_port === local);
  const twice = others.some((e) => e.host.id === hostId);
  const elsewhere = others.find((e) => e.host.id !== hostId);
  const ready = host !== undefined && remote !== null && local !== null && !twice && !busy;
  const service = SERVICES.find((s) => s.port === remote);

  const pick = (s: { name: string; port: number }) => {
    // The name goes along unless the user gave one of their own.
    if (!label.trim() || SERVICES.some((known) => known.name === label.trim())) setLabel(s.name);
    setRemotePort(String(s.port));
    if (!localTouched) setLocalPort(String(s.port));
  };

  const save = async (open: boolean) => {
    if (!ready || !host || remote === null || local === null) return;
    const input: PortForwardInput = {
      id: f?.id ?? null,
      label: label.trim(),
      local_port: local,
      remote_host: remoteHost.trim() || "localhost",
      remote_port: remote,
      auto,
    };
    const asInput = (x: PortForward): PortForwardInput => ({ ...x });
    setBusy(true);
    const saved = await mutate(async () => {
      const from = props.entry?.host;
      // Moved to another host: off the old one first.
      if (from && from.id !== host.id) {
        await api.hostSetForwards(from.id, from.forwards.filter((x) => x.id !== input.id).map(asInput));
      }
      const list =
        from && from.id === host.id
          ? host.forwards.map((x) => (x.id === input.id ? input : asInput(x)))
          : [...host.forwards.map(asInput), input];
      return api.hostSetForwards(host.id, list);
    });
    setBusy(false);
    if (!saved) return;
    if (open) {
      const forward = saved.forwards.find((x) => (input.id ? x.id === input.id : !host.forwards.some((o) => o.id === x.id)));
      if (forward) startForward({ host: saved, forward });
    }
    props.onClose();
  };

  const remove = async () => {
    if (!props.entry) return;
    const { host: from, forward } = props.entry;
    stopForward(props.entry);
    const done = await mutate(() =>
      api.hostSetForwards(from.id, from.forwards.filter((x) => x.id !== forward.id).map((x) => ({ ...x }))),
    );
    if (done) props.onClose();
  };

  const shownLocal = local ?? "—";
  const shownTarget = `${remoteHost.trim() || "localhost"}:${remote ?? "—"}`;

  return (
    <form
      className="panel fwd-editor"
      hidden={props.hidden}
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && props.onClose()}
    >
      <div className="panel-head">
        <h2>{t(f ? "fwd.edit.title" : "fwd.new.title")}</h2>
        {f && (
          <button type="button" className="btn ghost danger icon small" title={t("common.delete")} onClick={() => void remove()}>
            <Trash2 size={14} />
          </button>
        )}
        <button type="button" className="btn ghost icon small" onClick={props.onClose} aria-label={t("common.close")}>
          <X size={15} />
        </button>
      </div>

      {picking ? (
        <HostPicker
          hosts={props.hosts}
          current={hostId}
          onBack={() => setPicking(false)}
          onPick={(id) => {
            setHostId(id);
            setPicking(false);
          }}
          onAdd={() =>
            props.onAddHost((id) => {
              setHostId(id);
              setPicking(false);
            })
          }
        />
      ) : (
      <>
      <div className="panel-body scroll">
        <div className={cx("fwd-diagram", remote === null && "idle")} aria-hidden="true">
          <div className="fwd-node" key={`mac-${shownLocal}`}>
            <Laptop size={18} />
            <b>{t("fwd.diagram.mac")}</b>
            <span>:{shownLocal}</span>
          </div>
          <div className="fwd-link ssh">
            <span className="fwd-link-label">
              <Lock size={9} />
              SSH
            </span>
            <i className="fwd-packet" />
            <i className="fwd-packet late" />
          </div>
          <div className="fwd-node" key={`host-${hostId}`}>
            <Server size={18} />
            <b>{host ? hostTitle(host) : "…"}</b>
            <span>{t("fwd.diagram.server")}</span>
          </div>
          <div className="fwd-link">
            <i className="fwd-packet next" />
            <i className="fwd-packet next late" />
          </div>
          <div className="fwd-node" key={`svc-${remoteHost.trim()}-${remote}`}>
            <Database size={18} />
            <b>{label.trim() || service?.name || t("fwd.diagram.service")}</b>
            <span>{itself(remoteHost || "localhost") ? t("fwd.diagram.itself") : remoteHost.trim()}</span>
            <span>:{remote ?? "—"}</span>
          </div>
        </div>
        <p className="fwd-explain">
          {host && remote !== null && local !== null
            ? t("fwd.explain", { local: String(local), host: hostTitle(host), target: shownTarget })
            : t("fwd.explain.pending")}
        </p>

        <div className="field">
          <label>{t("fwd.host")}</label>
          <button type="button" className={cx("fwd-host-button", !host && "unset")} onClick={() => setPicking(true)}>
            {host ? (
              <>
                <span className="card-icon">
                  <OsIcon os={host.os} />
                </span>
                <span className="fwd-host-text">
                  <b>{hostTitle(host)}</b>
                  <span>{hostSubtitle(host, snapshot)}</span>
                </span>
              </>
            ) : (
              <>
                <span className="card-icon">
                  <Server size={17} />
                </span>
                <span className="fwd-host-text">
                  <b>{t("fwd.host.pick")}</b>
                  <span>{t("fwd.host.pick_hint")}</span>
                </span>
              </>
            )}
            <ChevronRight size={15} />
          </button>
        </div>

        <div className="field">
          <label>{t("fwd.helper")}</label>
          <div className="fwd-presets">
            {SERVICES.map((s) => (
              <button
                key={s.name}
                type="button"
                className={cx("chip", remote === s.port && "active")}
                onClick={() => pick(s)}
              >
                {s.name} <span className="dim">{s.port}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="row">
          <div className="grow field">
            <label>{t("fwd.dest")}</label>
            <input
              className="input mono"
              value={remoteHost}
              onChange={(e) => setRemoteHost(e.target.value)}
              placeholder="localhost"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
          <div className="field" style={{ width: 96 }}>
            <label>{t("fwd.dest_port")}</label>
            <input
              className="input mono"
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value.replace(/\D/g, "").slice(0, 5))}
              placeholder="5432"
              inputMode="numeric"
            />
          </div>
        </div>
        <span className="hint fwd-field-hint">{t("fwd.dest.hint")}</span>

        <div className="field">
          <label>{t("fwd.local_port")}</label>
          <input
            className="input mono"
            style={{ width: 96 }}
            value={localTouched ? localPort : remotePort}
            onChange={(e) => {
              setLocalTouched(true);
              setLocalPort(e.target.value.replace(/\D/g, "").slice(0, 5));
            }}
            placeholder="5432"
            inputMode="numeric"
          />
          {twice ? (
            <span className="error">{t("fwd.twice")}</span>
          ) : elsewhere ? (
            <span className="hint">{t("fwd.other_host", { port: String(local), name: elsewhere.forward.label || hostTitle(elsewhere.host) })}</span>
          ) : LINUX && local !== null && local < 1024 ? (
            <span className="hint">{t("fwd.privileged")}</span>
          ) : (
            <span className="hint">{t("fwd.local.hint")}</span>
          )}
        </div>

        <div className="field">
          <label>
            {t("fwd.label")} <span className="dim">· {t("common.optional")}</span>
          </label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Postgres" />
        </div>

        <label className="fwd-check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          {t("fwd.auto")}
        </label>
      </div>

      <div className="panel-foot">
        <div className="grow" />
        <button type="submit" className="btn" disabled={!ready}>
          {t("common.save")}
        </button>
        <button type="button" className="btn primary" disabled={!ready} onClick={() => void save(true)}>
          {t("fwd.save_open")}
        </button>
      </div>
      </>
      )}
    </form>
  );
}

/** The hosts to go through, to search and pick from, in their groups. */
function HostPicker(props: {
  hosts: HostView[];
  current: Id | null;
  onBack: () => void;
  onPick: (id: Id) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const snapshot = useVault((s) => s.snapshot);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => search.current?.focus(), []);
  const needle = query.trim().toLowerCase();
  const found = props.hosts
    .filter((h) => !needle || [hostTitle(h), h.address, hostSubtitle(h, snapshot), ...h.tags].some((x) => x.toLowerCase().includes(needle)))
    .sort(compareHosts);
  // Grouped as on the hosts page: hosts without a group first, then each group by its path.
  const paths = groupOptions(snapshot.groups);
  const sections: { title: string | null; hosts: HostView[] }[] = [
    { title: null, hosts: found.filter((h) => !h.group_id) },
    ...paths.map((g) => ({ title: g.path, hosts: found.filter((h) => h.group_id === g.id) })),
  ].filter((section) => section.hosts.length > 0);

  return (
    <>
      <div className="fwd-picker-head">
        <button type="button" className="btn ghost icon small" onClick={props.onBack} aria-label={t("fwd.host.back")}>
          <ArrowLeft size={15} />
        </button>
        <div className="search grow">
          <Search size={14} />
          <input
            ref={search}
            className="input"
            value={query}
            placeholder={t("fwd.host.search")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && found.length > 0) {
                e.preventDefault();
                props.onPick(found[0].id);
              }
              if (e.key === "Escape") {
                e.stopPropagation();
                props.onBack();
              }
            }}
            spellCheck={false}
          />
        </div>
        <button type="button" className="btn icon" title={t("hosts.new")} aria-label={t("hosts.new")} onClick={props.onAdd}>
          <Plus size={15} />
        </button>
      </div>
      <div className="panel-body scroll fwd-picker">
        {sections.map((section) => (
          <div key={section.title ?? ""} className="fwd-picker-section">
            <div className="section-title">{section.title ?? t("fwd.host.ungrouped")}</div>
            {section.hosts.map((h) => (
              <button
                key={h.id}
                type="button"
                className={cx("fwd-picker-row", h.id === props.current && "on")}
                onClick={() => props.onPick(h.id)}
              >
                <span className="card-icon">
                  <OsIcon os={h.os} />
                </span>
                <span className="fwd-host-text">
                  <b>{hostTitle(h)}</b>
                  <span>{hostSubtitle(h, snapshot)}</span>
                </span>
                {h.forwards.length > 0 && <span className="chip">{h.forwards.length}</span>}
              </button>
            ))}
          </div>
        ))}
        {props.hosts.length === 0 ? (
          <div className="fwd-picker-none">
            <p className="muted">{t("fwd.host.none")}</p>
            <button type="button" className="btn primary" onClick={props.onAdd}>
              <Plus size={15} />
              {t("hosts.new")}
            </button>
          </div>
        ) : (
          sections.length === 0 && <p className="muted">{t("fwd.no_results", { query: query.trim() })}</p>
        )}
      </div>
    </>
  );
}
