import { AlertTriangle, RotateCw } from "lucide-react";
import { useState } from "react";
import { reportError } from "../lib/actions";
import { api } from "../lib/api";
import { errorText, useT } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { useVault } from "../lib/store";
import { Modal } from "./ui";

/** A vault that is there but cannot be read can be given up for a new one. */
const REPLACEABLE = new Set(["vault_key_missing", "vault_decrypt"]);

/**
 * Shown instead of the app when the vault cannot be opened. Offers to try
 * again and, behind two warnings, to start an empty vault in its place.
 */
export function VaultError() {
  const t = useT();
  const error = useVault((s) => s.loadError);
  const dataDir = useVault((s) => s.status?.data_dir);
  const [step, setStep] = useState<"first" | "final" | null>(null);
  const [busy, setBusy] = useState(false);
  if (!error) return null;

  const retry = async () => {
    setBusy(true);
    try {
      const status = await api.vaultRetry();
      // Everything starts over with a vault that opens.
      if (!status.vault_error) return window.location.reload();
    } catch {
      // Still closed; the reason is read again below.
    }
    await useVault.getState().init();
    setBusy(false);
  };

  const replace = async () => {
    setBusy(true);
    try {
      await api.vaultReplace();
      // An empty vault again: offer to sign in, which is how synced data returns.
      useSettings.getState().set({ welcomed: false });
      window.location.reload();
    } catch (e) {
      setStep(null);
      setBusy(false);
      reportError(e);
      await useVault.getState().init();
    }
  };

  const cancel = () => !busy && setStep(null);

  return (
    <div className="fatal">
      <div className="box">
        <h1>{t("error.vault.title")}</h1>
        <p className="muted">{errorText(error)}</p>
        {error.detail && <p className="dim selectable">{error.detail}</p>}
        {dataDir && <p className="mono dim selectable">{dataDir}</p>}
        {error.code === "vault_key_missing" && <p className="dim">{t("vault.retry.hint")}</p>}
        <div className="fatal-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void retry()}>
            <RotateCw size={14} />
            {t("common.retry")}
          </button>
          {REPLACEABLE.has(error.code) && (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setStep("first")}>
              {t("vault.replace")}
            </button>
          )}
        </div>
      </div>

      {step === "first" && (
        <Modal
          danger
          title={t("vault.replace.title")}
          icon={<AlertTriangle size={17} />}
          onClose={cancel}
          footer={
            <>
              <button type="button" className="btn" onClick={cancel} data-autofocus>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn danger" onClick={() => setStep("final")}>
                {t("vault.replace.continue")}
              </button>
            </>
          }
        >
          <p>{t("vault.replace.text")}</p>
          <ul className="lost">
            <li>{t("vault.replace.lost.hosts")}</li>
            <li>{t("vault.replace.lost.keys")}</li>
            <li>{t("vault.replace.lost.snippets")}</li>
          </ul>
          <p className="note">{t("vault.replace.local")}</p>
        </Modal>
      )}
      {step === "final" && (
        <Modal
          danger
          title={t("vault.replace.final.title")}
          icon={<AlertTriangle size={17} />}
          onClose={cancel}
          footer={
            <>
              <button type="button" className="btn" disabled={busy} onClick={cancel} data-autofocus>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void replace()}>
                {t("vault.replace.confirm")}
              </button>
            </>
          }
        >
          <p>{t("vault.replace.final.text")}</p>
          <p className="note">{t("vault.replace.final.hint")}</p>
        </Modal>
      )}
    </div>
  );
}
