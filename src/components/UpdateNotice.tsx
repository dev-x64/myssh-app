import { AlertTriangle, ArrowUpCircle, Download, RotateCw, Undo2 } from "lucide-react";
import { errorText, useT } from "../lib/i18n";
import { useUi } from "../lib/store";
import { PUT_OFF_TIMES, useUpdate } from "../lib/update";
import { cx, Modal } from "./ui";

/**
 * A small button in the corner of the title bar, there only while another
 * version is on offer or is installed and waiting for a restart. It opens
 * the dialog; nothing else announces an update.
 */
export function UpdateButton() {
  const t = useT();
  const available = useUpdate((s) => s.available);
  const ready = useUpdate((s) => s.phase === "ready");
  const setDialog = useUpdate((s) => s.setDialog);
  if (!available) return null;
  return (
    <button
      className={cx("update-pill", available.rollback && !ready && "rollback")}
      title={t(
        ready ? "update.ready.hint" : available.rollback ? "update.rollback.hint" : "update.available.hint",
        { version: available.version, current: available.current },
      )}
      onClick={() => setDialog(true)}
    >
      {ready ? <RotateCw size={13} /> : available.rollback ? <Undo2 size={13} /> : <ArrowUpCircle size={13} />}
      <span>{t(ready ? "update.restart_pill" : available.rollback ? "update.rollback.pill" : "update.pill")}</span>
    </button>
  );
}

/**
 * The dialog that says what is new and installs it: now, with a restart,
 * or for the next launch. The app is restarted only from here, by the user.
 */
export function UpdateNotice() {
  const t = useT();
  const { available, phase, progress, error, dialog, setDialog, install, restart, putOff, postpone } = useUpdate();
  const toast = useUi((s) => s.toast);
  const sessions = useUi((s) => s.tabs.filter((tab) => tab.status !== "closed").length);
  const unsaved = useUi((s) => s.tabs.some((tab) => tab.editor && tab.editorDirty));
  const busy = phase === "downloading" || phase === "restarting";
  const ready = phase === "ready";
  if (!dialog || !available) return null;
  const back = available.rollback;

  // Closed without installing: counted, and after a few times it installs by itself.
  const close = () => {
    setDialog(false);
    postpone();
  };
  const later = async () => {
    if (!(await install(false))) return;
    setDialog(false);
    toast("success", t("update.ready.toast", { version: available.version }));
  };
  const restartNotes = unsaved ? (
    <div className="notice error">
      <AlertTriangle size={15} />
      <span>{t("update.unsaved")}</span>
    </div>
  ) : (
    sessions > 0 &&
    !busy && (
      <div className="notice">
        <AlertTriangle size={15} />
        <span>{t("update.sessions", { n: sessions })}</span>
      </div>
    )
  );

  return (
    <Modal
      title={t(ready ? "update.ready.title" : back ? "update.rollback.title" : "update.title", {
        version: available.version,
      })}
      icon={back && !ready ? <Undo2 size={17} /> : <Download size={17} />}
      onClose={() => !busy && close()}
      onSubmit={() => !unsaved && void (ready ? restart() : install(true))}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={close}>
            {t("update.later")}
          </button>
          {!ready && (
            <button type="button" className="btn" disabled={busy} onClick={() => void later()}>
              {t("update.next_launch")}
            </button>
          )}
          <button type="submit" className="btn primary" disabled={busy || unsaved} data-autofocus>
            {t(ready ? "update.restart" : back ? "update.rollback.install" : "update.install")}
          </button>
        </>
      }
    >
      {ready ? (
        <p>{t("update.ready.text")}</p>
      ) : (
        <>
          <p>
            {t(back ? "update.rollback.text" : "update.current", {
              version: back ? available.version : available.current,
              current: available.current,
            })}
          </p>
          {available.notes && <pre className="update-notes selectable scroll">{available.notes}</pre>}
          {putOff === PUT_OFF_TIMES - 1 && <p className="muted">{t("update.last_put_off")}</p>}
        </>
      )}
      {restartNotes}
      {busy && (
        <div className="update-progress" role="status">
          <div className="update-bar">
            <div
              className={progress === null ? "indeterminate" : undefined}
              style={progress === null ? undefined : { width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <span>
            {phase === "restarting"
              ? t("update.restarting")
              : progress === null
                ? t("update.downloading")
                : t("update.downloading.percent", { n: Math.round(progress * 100) })}
          </span>
        </div>
      )}
      {error && (
        <div className="notice error">
          <AlertTriangle size={15} />
          <span className="selectable">
            {errorText(error)}
            {error.detail ? `: ${error.detail}` : ""}
          </span>
        </div>
      )}
    </Modal>
  );
}
