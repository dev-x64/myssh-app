import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { api, asApiError, type ApiError } from "../../lib/api";
import { useCloud } from "../../lib/cloud";
import { errorText, useT } from "../../lib/i18n";
import { useUi, useVault } from "../../lib/store";
import { Field, Modal, PasswordInput } from "../ui";

/** What has to be typed, letter for letter, before an account is deleted. */
const WORD = "DELETE";

/**
 * Deleting the cloud account: at the very bottom of the settings, apart
 * from everything else, and behind two confirmations. The second asks for
 * the master password, which the server checks, and for a word typed out.
 */
export function DeleteAccount() {
  const t = useT();
  const account = useVault((s) => s.snapshot.cloud);
  const toast = useUi((s) => s.toast);
  const [step, setStep] = useState<"first" | "final" | null>(null);
  const [password, setPassword] = useState("");
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // A device that was signed out from elsewhere can no longer speak for the account.
  if (!account || account.revoked) return null;
  const email = account.email;
  const cancel = () => {
    if (busy) return;
    setStep(null);
    setPassword("");
    setWord("");
    setError(null);
  };
  const ready = password !== "" && word === WORD;
  const remove = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.cloudDeleteAccount(password);
    } catch (e) {
      setError(asApiError(e));
      setBusy(false);
      return;
    }
    useCloud.setState({ state: "idle", error: null, conflicts: [] });
    await useVault.getState().refresh();
    toast("success", t("account.delete.done"));
  };

  return (
    <>
      <div className="danger-zone">
        <div className="setting-text">
          <div className="name">{t("account.delete")}</div>
          <div className="hint">{t("account.delete.hint", { email })}</div>
        </div>
        <button className="btn danger small" onClick={() => setStep("first")}>
          {t("account.delete")}
        </button>
      </div>

      {step === "first" && (
        <Modal
          danger
          title={t("account.delete.title")}
          icon={<AlertTriangle size={17} />}
          onClose={cancel}
          footer={
            <>
              <button type="button" className="btn" onClick={cancel} data-autofocus>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn danger" onClick={() => setStep("final")}>
                {t("account.delete.continue")}
              </button>
            </>
          }
        >
          <p>{t("account.delete.text", { email })}</p>
          <ul className="lost">
            <li>{t("account.delete.lost.data")}</li>
            <li>{t("account.delete.lost.devices")}</li>
            <li>{t("account.delete.lost.forever")}</li>
          </ul>
          <p className="note">{t("account.delete.local")}</p>
        </Modal>
      )}
      {step === "final" && (
        <Modal
          danger
          title={t("account.delete.final.title")}
          icon={<AlertTriangle size={17} />}
          onClose={cancel}
          onSubmit={() => void remove()}
          footer={
            <>
              <button type="button" className="btn" disabled={busy} onClick={cancel}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="btn danger" disabled={busy || !ready}>
                {t("account.delete.confirm")}
              </button>
            </>
          }
        >
          <p>{t("account.delete.final.text", { email })}</p>
          <Field label={t("account.delete.password")}>
            <PasswordInput
              data-autofocus
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label={t("account.delete.word", { word: WORD })}>
            <input
              className="input mono"
              value={word}
              disabled={busy}
              placeholder={WORD}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              onChange={(e) => setWord(e.target.value)}
            />
          </Field>
          {error && (
            <div className="notice error">
              <AlertTriangle size={15} />
              <span className="selectable">
                {error.code === "bad_credentials" ? t("account.delete.wrong_password") : errorText(error)}
                {error.code !== "bad_credentials" && error.detail ? `: ${error.detail}` : ""}
              </span>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
