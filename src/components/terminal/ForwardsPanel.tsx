import { ArrowRight, Cable, Check, Copy, Globe, Pencil, Plus, Trash2 } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useRef, useState } from "react";
import { mutate, reportError } from "../../lib/actions";
import { api, type ApiError, type PortForward, type PortForwardInput } from "../../lib/api";
import { closeForward, openForward, refreshForwards, useForwards, type OpenForward } from "../../lib/forwards";
import { errorText, useT, type T } from "../../lib/i18n";
import { LINUX } from "../../lib/platform";
import { useVault, type Tab } from "../../lib/store";
import { cx, Switch } from "../ui";

/** How often an open panel asks how the forwards are doing. */
const REFRESH_MS = 1500;

const target = (f: Pick<PortForward, "remote_host" | "remote_port">) => `${f.remote_host}:${f.remote_port}`;

/**
 * The button in the title bar for the ports forwarded through the active
 * terminal's connection, and its panel: the host's forwards, each opened
 * and closed with a switch, added, changed and removed in place.
 */
export function ForwardsButton({ tab }: { tab: Tab }) {
  const t = useT();
  const host = useVault((s) => s.snapshot.hosts.find((h) => h.id === tab.hostId));
  const state = useForwards((s) => s.tabs[tab.id]);
  const [open, setOpen] = useState(false);
  /** The forward being edited; `null` is a new one. */
  const [editing, setEditing] = useState<PortForward | null | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const forwards = host?.forwards ?? [];
  const openCount = Object.values(state?.open ?? {}).filter((f) => f.state === "open").length;
  const connected = tab.status === "connected";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setEditing(undefined);
      return;
    }
    void refreshForwards(tab.id);
    const timer = window.setInterval(() => void refreshForwards(tab.id), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [open, tab.id]);

  if (!host) return null;

  const save = async (list: PortForwardInput[]) => {
    const saved = await mutate(() => api.hostSetForwards(host.id, list));
    if (saved) setEditing(undefined);
    return saved;
  };
  const asInput = (f: PortForward): PortForwardInput => ({ ...f });
  const submit = async (input: PortForwardInput) => {
    const list = input.id
      ? forwards.map((f) => (f.id === input.id ? input : asInput(f)))
      : [...forwards.map(asInput), input];
    const saved = await save(list);
    // A new forward is opened at once: it was added to be used.
    if (saved && !input.id) {
      const added = saved.forwards.find((f) => !forwards.some((old) => old.id === f.id));
      if (added) void openForward(tab.id, added);
    }
  };
  const remove = async (forward: PortForward) => {
    closeForward(tab.id, forward.id);
    await save(forwards.filter((f) => f.id !== forward.id).map(asInput));
  };

  return (
    <div className="share forwards" ref={root}>
      <button
        className={cx("btn ghost icon small", (open || openCount > 0) && "on")}
        title={openCount > 0 ? t("fwd.open_count", { n: openCount }) : t("fwd.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Cable size={15} />
        {openCount > 0 && <span className="share-count">{openCount}</span>}
      </button>

      {open && (
        <div className="share-panel fwd-panel" role="dialog" aria-label={t("fwd.title")}>
          <div className="share-head">
            <Cable size={15} />
            <span className="grow">{t("fwd.title")}</span>
            {editing === undefined && forwards.length > 0 && (
              <button className="btn small" onClick={() => setEditing(null)}>
                <Plus size={13} />
                {t("fwd.add")}
              </button>
            )}
          </div>

          <div className="share-body">
            {editing !== undefined ? (
              <ForwardForm
                forward={editing}
                taken={forwards.filter((f) => f.id !== editing?.id).map((f) => f.local_port)}
                onCancel={() => setEditing(undefined)}
                onSubmit={submit}
              />
            ) : forwards.length === 0 ? (
              <>
                <p>{t("fwd.intro")}</p>
                <p className="dim">{t("fwd.example")}</p>
                <button className="btn primary" onClick={() => setEditing(null)}>
                  <Plus size={14} />
                  {t("fwd.add_first")}
                </button>
              </>
            ) : (
              <>
                {!connected && <p className="note">{t("fwd.offline")}</p>}
                <div className="fwd-list">
                  {forwards.map((forward) => (
                    <ForwardRow
                      key={forward.id}
                      forward={forward}
                      wanted={state?.wanted.includes(forward.id) ?? false}
                      live={state?.open[forward.id]}
                      connected={connected}
                      onToggle={(on) => (on ? void openForward(tab.id, forward) : closeForward(tab.id, forward.id))}
                      onEdit={() => setEditing(forward)}
                      onDelete={() => void remove(forward)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ForwardRow(props: {
  forward: PortForward;
  wanted: boolean;
  live: OpenForward | undefined;
  connected: boolean;
  onToggle: (on: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const { forward, live } = props;
  const [copied, setCopied] = useState(false);
  const address = `localhost:${forward.local_port}`;
  const up = live?.state === "open";

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await writeText(address);
      setCopied(true);
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <div className={cx("fwd-row", up && "up")}>
      <Switch on={props.wanted} onChange={props.onToggle} label={t("fwd.toggle", { address })} />
      <div className="fwd-main">
        <div className="fwd-name">
          <span className="fwd-port">{forward.local_port}</span>
          {forward.label && <span className="fwd-label">{forward.label}</span>}
          {forward.auto && <span className="chip">{t("fwd.auto_chip")}</span>}
        </div>
        <div className="fwd-route">
          {address}
          <ArrowRight size={11} />
          {target(forward)}
        </div>
        <ForwardState t={t} forward={forward} wanted={props.wanted} live={live} connected={props.connected} />
      </div>
      <div className="fwd-actions">
        {up && (
          <>
            <button className="btn ghost icon small" title={t("fwd.browser")} onClick={() => void api.openLink(`http://${address}`).catch(reportError)}>
              <Globe size={14} />
            </button>
            <button className={cx("btn ghost icon small", copied && "done")} title={t(copied ? "common.copied" : "fwd.copy")} onClick={() => void copy()}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </>
        )}
        <button className="btn ghost icon small" title={t("common.edit")} onClick={props.onEdit}>
          <Pencil size={14} />
        </button>
        <button className="btn ghost icon small" title={t("common.delete")} onClick={props.onDelete}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

/** One line on how a forward is doing, if it is wanted at all. */
function ForwardState(props: { t: T; forward: PortForward; wanted: boolean; live: OpenForward | undefined; connected: boolean }) {
  const { t, forward, live } = props;
  if (!props.wanted) return null;
  if (!props.connected || !live) return <div className="fwd-state dim">{t("fwd.state.waiting")}</div>;
  if (live.state === "opening") return <div className="fwd-state dim">{t("fwd.state.opening")}</div>;
  if (live.state === "failed") return <div className="fwd-state bad">{failedText(t, live.error)}</div>;
  const status = live.status;
  const failure = status?.failure;
  if (failure) {
    const key = ({ refused: "fwd.failure.refused", prohibited: "fwd.failure.prohibited", timeout: "fwd.failure.timeout", closed: "fwd.failure.closed", other: "fwd.failure.other" } as const)[failure.code];
    return (
      <div className="fwd-state bad" title={failure.detail ?? undefined}>
        {t(key, { target: target(forward) })}
      </div>
    );
  }
  return (
    <div className="fwd-state ok">
      {status && status.open > 0 ? t("fwd.state.carrying", { n: status.open }) : t("fwd.state.open")}
    </div>
  );
}

function failedText(t: T, error: ApiError | null): string {
  if (!error) return t("fwd.state.failed");
  return error.code === "port_in_use" ? t("fwd.port_in_use") : errorText(error);
}

const portOf = (text: string): number | null => {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
};

/**
 * Adds or changes a forward. A block, not a form: it also sits inside the
 * host editor's form. Enter submits it, Escape cancels it.
 */
export function ForwardForm(props: {
  forward: PortForward | null;
  /** Ports this host's other forwards take here. */
  taken: number[];
  onCancel: () => void;
  onSubmit: (input: PortForwardInput) => Promise<void>;
}) {
  const t = useT();
  const f = props.forward;
  const [remoteHost, setRemoteHost] = useState(f?.remote_host ?? "localhost");
  const [remotePort, setRemotePort] = useState(f ? String(f.remote_port) : "");
  const [localPort, setLocalPort] = useState(f ? String(f.local_port) : "");
  // A new forward takes the same port here as there, until told otherwise.
  const [localTouched, setLocalTouched] = useState(f !== null);
  const [label, setLabel] = useState(f?.label ?? "");
  const [auto, setAuto] = useState(f?.auto ?? false);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => first.current?.focus(), []);

  const remote = portOf(remotePort);
  const local = portOf(localTouched ? localPort : remotePort);
  const twice = local !== null && props.taken.includes(local);
  const privileged = LINUX && local !== null && local < 1024;
  const ready = remote !== null && local !== null && !twice && !busy;

  const submit = async () => {
    if (!ready || local === null || remote === null) return;
    setBusy(true);
    await props.onSubmit({
      id: f?.id ?? null,
      label: label.trim(),
      local_port: local,
      remote_host: remoteHost.trim() || "localhost",
      remote_port: remote,
      auto,
    });
    setBusy(false);
  };

  return (
    <div
      className="fwd-form"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox") {
          e.preventDefault();
          void submit();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <div className="fwd-form-label">{t("fwd.on_server")}</div>
      <div className="fwd-pair">
        <input
          ref={first}
          className="input grow"
          value={remoteHost}
          onChange={(e) => setRemoteHost(e.target.value)}
          placeholder="localhost"
          aria-label={t("fwd.address")}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <span className="dim">:</span>
        <input
          className="input port"
          value={remotePort}
          onChange={(e) => setRemotePort(e.target.value.replace(/\D/g, ""))}
          placeholder="5432"
          aria-label={t("fwd.port")}
          inputMode="numeric"
        />
      </div>
      <div className="fwd-form-label">{t("fwd.here")}</div>
      <div className="fwd-pair">
        <span className="fwd-fixed">localhost</span>
        <span className="dim">:</span>
        <input
          className="input port"
          value={localTouched ? localPort : remotePort}
          onChange={(e) => {
            setLocalTouched(true);
            setLocalPort(e.target.value.replace(/\D/g, ""));
          }}
          placeholder="5432"
          aria-label={t("fwd.local_port")}
          inputMode="numeric"
        />
      </div>
      {twice && <p className="fwd-hint bad">{t("fwd.twice")}</p>}
      {privileged && <p className="fwd-hint">{t("fwd.privileged")}</p>}
      <input
        className="input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t("fwd.label_placeholder")}
        aria-label={t("fwd.label")}
      />
      <label className="fwd-check">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        {t("fwd.auto")}
      </label>
      <div className="fwd-buttons">
        <button type="button" className="btn small" onClick={props.onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn small primary" disabled={!ready} onClick={() => void submit()}>
          {t(f ? "common.save" : "fwd.add")}
        </button>
      </div>
    </div>
  );
}
