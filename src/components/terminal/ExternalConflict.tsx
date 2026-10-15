import { AlertTriangle, Upload } from "lucide-react";
import { answerChange, resolveConflict, useExternal } from "../../lib/external";
import { useT } from "../../lib/i18n";
import type { Tab } from "../../lib/store";
import { Modal } from "../ui";

/**
 * Questions about a file opened in another app. Saved there: should it go
 * to the server? And if the server's copy has changed meanwhile: which
 * one stays? Nothing is sent until the user answers.
 */
export function ExternalConflict({ tab }: { tab: Tab }) {
  const t = useT();
  const file = useExternal((s) =>
    s.files.find((f) => f.tabId === tab.id && (f.state === "conflict" || f.state === "asking")),
  );
  if (!file) return null;
  const where = (
    <p className="dim selectable">
      {file.app ? `${file.app} · ` : ""}
      {file.remote}
    </p>
  );

  if (file.state === "asking") {
    const cancel = () => void answerChange(file.id, false);
    return (
      <Modal
        scope="tab"
        title={t("external.ask.title", { name: file.name })}
        icon={<Upload size={17} />}
        onClose={cancel}
        onSubmit={() => void answerChange(file.id, true)}
        footer={
          <>
            <button type="button" className="btn" onClick={cancel}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn primary" data-autofocus>
              {t("external.ask.send")}
            </button>
          </>
        }
      >
        <p>{t("external.ask.text")}</p>
        {where}
      </Modal>
    );
  }

  const keep = () => void resolveConflict(file.id, false);
  return (
    <Modal
      scope="tab"
      danger
      title={t("external.conflict.title", { name: file.name })}
      icon={<AlertTriangle size={17} />}
      onClose={keep}
      footer={
        <>
          <button type="button" className="btn" data-autofocus onClick={keep}>
            {t("external.conflict.keep")}
          </button>
          <button type="button" className="btn danger" onClick={() => void resolveConflict(file.id, true)}>
            {t("external.conflict.replace")}
          </button>
        </>
      }
    >
      <p>{t("external.conflict.text")}</p>
      {where}
    </Modal>
  );
}
