import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { pickLocalFile } from "../../lib/pickFile";
import { MOBILE } from "../../lib/platform";
import { ChevronRight, Download, FileUp, Folder, KeyRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { reportError } from "../../lib/actions";
import { api, type FoundHost, type ImportSource } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useUi, useVault } from "../../lib/store";
import { cx, Modal } from "../ui";

/**
 * Brings hosts over from another SSH client in two steps: where from (what
 * was found on this computer, or a file chosen by hand), then which hosts.
 * Folders become groups, key files go into the keychain, and hosts already
 * saved here are left unticked.
 */
/** `initial`: a source found already, opened at once (the first launch offers them). */
export function ImportDialog({ onClose, initial }: { onClose: () => void; initial?: ImportSource }) {
  const t = useT();
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [source, setSource] = useState<ImportSource | null>(initial ?? null);
  const [chosen, setChosen] = useState<Set<number>>(
    () => new Set(initial?.hosts.flatMap((host, index) => (host.exists ? [] : [index])) ?? []),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.importScan().then(setSources, (error) => {
      reportError(error);
      setSources([]);
    });
  }, []);

  const open = (found: ImportSource) => {
    setSource(found);
    setChosen(new Set(found.hosts.flatMap((host, index) => (host.exists ? [] : [index]))));
  };

  const pick = async () => {
    // A phone's picker hands over a file to read, not a path.
    if (MOBILE) {
      const file = await pickLocalFile();
      if (!file) return;
      setBusy(true);
      await api.importText(await file.text(), file.name).then(open, reportError);
      setBusy(false);
      return;
    }
    const path = await pickFile({ multiple: false, directory: false });
    if (typeof path !== "string") return;
    setBusy(true);
    await api.importFile(path).then(open, reportError);
    setBusy(false);
  };

  const run = async () => {
    if (!source || chosen.size === 0) return;
    setBusy(true);
    const hosts: FoundHost[] = source.hosts
      .filter((_, index) => chosen.has(index))
      .map(({ label, address, port, username, folder, key_file, password, tags, forwards }) => ({
        label,
        address,
        port,
        username,
        folder,
        key_file,
        password,
        tags,
        forwards,
      }));
    try {
      const report = await api.importApply(hosts);
      await useVault.getState().refresh();
      const ui = useUi.getState();
      ui.toast("success", t("import.done", { hosts: t("hosts.count", { n: report.hosts }), keys: report.keys }));
      if (report.keys_skipped.length > 0) {
        ui.toast("error", t("import.keys_skipped", { names: report.keys_skipped.join(", ") }));
      }
      onClose();
    } catch (error) {
      reportError(error);
      setBusy(false);
    }
  };

  // The hosts in their folders, folders in the order first met.
  const sections = useMemo(() => {
    const map = new Map<string, number[]>();
    source?.hosts.forEach((host, index) => {
      const name = host.folder.join(" / ");
      map.set(name, [...(map.get(name) ?? []), index]);
    });
    return [...map.entries()];
  }, [source]);

  const all = source !== null && source.hosts.length > 0 && chosen.size === source.hosts.length;

  return (
    <Modal
      title={t("import.title")}
      icon={<Download size={17} />}
      wide
      onClose={onClose}
      onSubmit={() => void run()}
      footer={
        source ? (
          <>
            <button type="button" className="btn" onClick={() => setSource(null)}>
              {t("import.back")}
            </button>
            <button type="submit" className="btn primary" disabled={chosen.size === 0 || busy}>
              {t("import.go", { n: chosen.size })}
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
        )
      }
    >
      {!source ? (
        <>
          {sources === null ? (
            <p className="import-wait">
              <span className="spinner" />
              {t("import.scanning")}
            </p>
          ) : sources.length > 0 ? (
            <>
              <div className="section-title">{t("import.found")}</div>
              <div className="import-sources">
                {sources.map((found) => (
                  <button key={found.kind + found.location} type="button" className="import-source" onClick={() => open(found)}>
                    <span className="card-icon accent small">
                      <Download size={15} />
                    </span>
                    <span className="import-main">
                      <b>{t(`import.kind.${found.kind}`)}</b>
                      <small>
                        {t("hosts.count", { n: found.hosts.length })} · {found.location}
                      </small>
                    </span>
                    <ChevronRight size={15} className="dim" />
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="dim">{t("import.none")}</p>
          )}
          <div className="import-pick">
            <button type="button" className="btn" onClick={() => void pick()} disabled={busy}>
              <FileUp size={15} />
              {t("import.pick")}
            </button>
            <p className="dim">{t("import.pick.hint")}</p>
          </div>
        </>
      ) : source.hosts.length === 0 ? (
        <p className="dim">{t("import.nothing")}</p>
      ) : (
        <>
          <div className="import-head">
            <div className="import-main">
              <b>{t(`import.kind.${source.kind}`)}</b>
              <small>{source.location}</small>
            </div>
            <button
              type="button"
              className="btn small"
              onClick={() => setChosen(all ? new Set() : new Set(source.hosts.map((_, index) => index)))}
            >
              {t("import.select_all")}
            </button>
          </div>
          <div className="import-hosts scroll">
            {sections.map(([folder, indexes]) => (
              <div key={folder}>
                {folder && (
                  <div className="import-folder">
                    <Folder size={13} />
                    {folder}
                  </div>
                )}
                {indexes.map((index) => {
                  const host = source.hosts[index];
                  const on = chosen.has(index);
                  return (
                    <label key={index} className={cx("import-host", host.exists && "exists")}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setChosen((set) => {
                            const next = new Set(set);
                            if (on) next.delete(index);
                            else next.add(index);
                            return next;
                          })
                        }
                      />
                      <span className="import-main">
                        <b>{host.label}</b>
                        <small>
                          {host.username ? `${host.username}@` : ""}
                          {host.address}
                          {host.port !== 22 ? `:${host.port}` : ""}
                        </small>
                      </span>
                      <span className="import-tags">
                        {host.key_name && (
                          <span className={cx("chip", !host.key_found && "warn")} title={host.key_file ?? ""}>
                            <KeyRound size={11} />
                            {host.key_found ? host.key_name : t("import.key_missing", { name: host.key_name })}
                          </span>
                        )}
                        {host.password && <span className="chip">{t("import.password")}</span>}
                        {host.exists && <span className="chip dim">{t("import.exists")}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
