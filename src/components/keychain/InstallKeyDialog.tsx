import { Channel } from "@tauri-apps/api/core";
import { AlertTriangle, Check, ChevronRight, CircleDashed, Search, ServerCog } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  asApiError,
  type ApiError,
  type HostView,
  type Id,
  type KeyView,
  type Prompt,
  type SessionEvent,
  type Stage,
} from "../../lib/api";
import { errorText, useT, type MessageKey } from "../../lib/i18n";
import { hostSubtitle, hostTitle, useVault } from "../../lib/store";
import { PromptDialog } from "../terminal/PromptDialog";
import { cx, Modal } from "../ui";

/** What happened on one host. Each host gets its own, independent result. */
interface Row {
  host: HostView;
  state: "waiting" | "running" | "done";
  stage: Stage | null;
  installed: "added" | "present" | null;
  verified: boolean;
  assigned: "yes" | "identity" | "failed" | null;
  error: ApiError | null;
  cancelled: boolean;
}

function usesKey(host: HostView, key: KeyView, identities: { id: Id; key_id: Id | null }[]): boolean {
  if (host.auth.kind === "inline") return host.auth.key_id === key.id;
  const identityId = host.auth.identity_id;
  return identities.find((identity) => identity.id === identityId)?.key_id === key.id;
}

export function InstallKeyDialog(props: { keyView: KeyView; onClose: () => void }) {
  const t = useT();
  const key = props.keyView;
  const snapshot = useVault((s) => s.snapshot);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Set<Id>>(new Set());
  const [assign, setAssign] = useState(true);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [running, setRunning] = useState(false);
  const [prompt, setPrompt] = useState<{ session: number; id: number; prompt: Prompt } | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const stopped = useRef(false);
  const current = useRef<number | null>(null);

  // The script each server will run, shown word for word under Details.
  useEffect(() => {
    void api.keyInstallScript(key.id).then(setScript, () => setScript(null));
  }, [key.id]);

  // Closing the dialog abandons whatever is still in flight.
  useEffect(
    () => () => {
      stopped.current = true;
      if (current.current !== null) void api.sessionClose(current.current);
    },
    [],
  );

  const hosts = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return snapshot.hosts
      .filter((host) => {
        const haystack = [hostTitle(host), hostSubtitle(host, snapshot), ...host.tags].join("\n").toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .sort((a, b) => hostTitle(a).localeCompare(hostTitle(b)));
  }, [snapshot, query]);

  const toggle = (id: Id) =>
    setChosen((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const patch = (hostId: Id, change: Partial<Row>) =>
    setRows((list) => list?.map((row) => (row.host.id === hostId ? { ...row, ...change } : row)) ?? null);

  /** Installs on one host and resolves when that host is finished. */
  const installOn = (host: HostView) =>
    new Promise<void>((resolve) => {
      let verified = false;
      const events = new Channel<SessionEvent>();
      events.onmessage = (event) => {
        switch (event.type) {
          case "stage":
            patch(host.id, { stage: event.stage });
            break;
          case "prompt":
            if (current.current !== null) {
              setPrompt({ session: current.current, id: event.id, prompt: event.prompt });
            }
            break;
          case "key_installed":
            patch(host.id, { installed: event.already_present ? "present" : "added" });
            break;
          case "key_verified":
            verified = true;
            patch(host.id, { verified: true });
            break;
          case "closed":
            void (async () => {
              current.current = null;
              setPrompt(null);
              let assigned: Row["assigned"] = null;
              if (verified && assign) {
                try {
                  assigned = (await api.hostAssignKey(host.id, key.id)) ? "yes" : "identity";
                } catch {
                  assigned = "failed";
                }
              }
              patch(host.id, {
                state: "done",
                stage: null,
                assigned,
                error: event.error,
                cancelled: event.reason === "user",
              });
              resolve();
            })();
            break;
        }
      };
      patch(host.id, { state: "running", stage: "connecting" });
      api
        .keyInstall(key.id, host.id, events)
        .then((session) => {
          current.current = session;
          if (stopped.current) void api.sessionClose(session);
        })
        .catch((e) => {
          patch(host.id, { state: "done", stage: null, error: asApiError(e) });
          resolve();
        });
    });

  const start = async () => {
    const targets = snapshot.hosts.filter((host) => chosen.has(host.id));
    if (targets.length === 0) return;
    stopped.current = false;
    setRows(
      targets.map((host) => ({
        host,
        state: "waiting",
        stage: null,
        installed: null,
        verified: false,
        assigned: null,
        error: null,
        cancelled: false,
      })),
    );
    setRunning(true);
    for (const host of targets) {
      if (stopped.current) {
        patch(host.id, { state: "done", cancelled: true });
        continue;
      }
      await installOn(host);
    }
    setRunning(false);
    await useVault.getState().refresh();
  };

  const stop = () => {
    stopped.current = true;
    if (current.current !== null) void api.sessionClose(current.current);
  };

  const describe = (row: Row): { tone: "ok" | "warn" | "bad" | "idle"; text: string } => {
    if (row.state === "waiting") return { tone: "idle", text: t("install.waiting") };
    if (row.state === "running") {
      return { tone: "idle", text: t(`install.stage.${row.stage ?? "connecting"}` as MessageKey) };
    }
    const cause = row.error
      ? `: ${errorText(row.error)}${row.error.detail ? ` — ${row.error.detail}` : ""}`
      : "";
    if (!row.installed) {
      return row.cancelled
        ? { tone: "idle", text: t("install.cancelled") }
        : { tone: "bad", text: `${t("install.failed")}${cause}` };
    }
    if (!row.verified) {
      return row.cancelled
        ? { tone: "warn", text: `${t(row.installed === "added" ? "install.added" : "install.present")}. ${t("install.cancelled")}` }
        : { tone: "warn", text: `${t("install.unverified")}${cause}` };
    }
    const parts = [
      t(row.installed === "added" ? "install.added" : "install.present"),
      t("install.verified"),
    ];
    if (row.assigned === "yes") parts.push(t("install.assigned"));
    if (row.assigned === "identity") parts.push(t("install.assigned.identity"));
    if (row.assigned === "failed") parts.push(t("install.assigned.failed"));
    return { tone: row.assigned === "failed" ? "warn" : "ok", text: parts.join("; ") };
  };

  const title = t("install.title", { name: key.label || key.algorithm });

  return (
    <>
      <Modal
        wide
        title={title}
        icon={<ServerCog size={17} />}
        onClose={() => !running && props.onClose()}
        onSubmit={rows ? undefined : () => void start()}
        footer={
          rows ? (
            running ? (
              <button type="button" className="btn" onClick={stop}>
                {t("install.stop")}
              </button>
            ) : (
              <button type="button" className="btn primary" data-autofocus onClick={props.onClose}>
                {t("install.done")}
              </button>
            )
          ) : (
            <>
              <button type="button" className="btn" onClick={props.onClose}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="btn primary" disabled={chosen.size === 0}>
                {t("install.start", { n: Math.max(chosen.size, 1) })}
              </button>
            </>
          )
        }
      >
        {rows ? (
          <div className="install-rows">
            {rows.map((row) => {
              const { tone, text } = describe(row);
              return (
                <div key={row.host.id} className={cx("install-row", tone)}>
                  <span className="install-icon">
                    {row.state === "running" ? (
                      <span className="spinner" />
                    ) : tone === "ok" ? (
                      <Check size={15} />
                    ) : tone === "idle" ? (
                      <CircleDashed size={15} />
                    ) : (
                      <AlertTriangle size={15} />
                    )}
                  </span>
                  <div className="install-main">
                    <div className="install-host">{hostTitle(row.host)}</div>
                    <div className="install-text selectable">{text}</div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <>
            <p>{t("install.text")}</p>
            {snapshot.hosts.length === 0 ? (
              <p>{t("install.none")}</p>
            ) : (
              <>
                <div className="row" style={{ alignItems: "center" }}>
                  <div className="search grow" style={{ maxWidth: "none" }}>
                    <Search size={14} />
                    <input
                      className="input"
                      data-autofocus
                      value={query}
                      placeholder={t("install.search")}
                      onChange={(e) => setQuery(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() =>
                      setChosen((set) => {
                        const all = hosts.every((host) => set.has(host.id));
                        const next = new Set(set);
                        for (const host of hosts) {
                          if (all) next.delete(host.id);
                          else next.add(host.id);
                        }
                        return next;
                      })
                    }
                  >
                    {t("install.select_all")}
                  </button>
                </div>
                <div className="install-hosts scroll">
                  {hosts.map((host) => (
                    <label key={host.id} className="install-pick">
                      <input type="checkbox" checked={chosen.has(host.id)} onChange={() => toggle(host.id)} />
                      <span className="install-main">
                        <span className="install-host">{hostTitle(host)}</span>
                        <span className="install-text">
                          {hostSubtitle(host, snapshot)}
                          {usesKey(host, key, snapshot.identities) && ` · ${t("install.uses_key")}`}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <label className="check">
                  <input type="checkbox" checked={assign} onChange={(e) => setAssign(e.target.checked)} />
                  <span>
                    {t("install.assign")}
                    <span className="dim" style={{ display: "block", fontSize: 12 }}>
                      {t("install.assign.hint")}
                    </span>
                  </span>
                </label>
                {script && (
                  <details className="install-details">
                    <summary>
                      <ChevronRight size={14} />
                      {t("install.details")}
                    </summary>
                    <p>{t("install.details.text")}</p>
                    <pre className="selectable scroll">{script.trimEnd()}</pre>
                  </details>
                )}
              </>
            )}
          </>
        )}
      </Modal>

      {prompt && (
        <PromptDialog
          key={`${prompt.session}-${prompt.id}`}
          scope="window"
          prompt={prompt.prompt}
          onReply={(reply) => {
            const pending = prompt;
            setPrompt(null);
            void api.sessionReply(pending.session, pending.id, reply).catch(() => {});
          }}
        />
      )}
    </>
  );
}
