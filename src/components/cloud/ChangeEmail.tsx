import { AlertTriangle, AtSign } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, asApiError, type ApiError } from "../../lib/api";
import { errorText, useT } from "../../lib/i18n";
import { useUi, useVault } from "../../lib/store";
import { Field, Modal, PasswordInput } from "../ui";
import { EmailTypo } from "./EmailTypo";

/** Whether the dialog is open: from the Cloud page, or from the account's page in the browser. */
export const useEmailDialog = create<{ open: boolean }>(() => ({ open: false }));

export function openEmailDialog() {
  useUi.getState().goHome("cloud");
  useEmailDialog.setState({ open: true });
}

/**
 * Changing the e-mail the account signs in with. The master password is
 * asked for, and checked by the server: a session in a browser, or a
 * device left unlocked, must not be enough to take the account over.
 */
export function ChangeEmailDialog() {
  const t = useT();
  const open = useEmailDialog((s) => s.open);
  const account = useVault((s) => s.snapshot.cloud);
  const toast = useUi((s) => s.toast);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (open) {
      setEmail("");
      setPassword("");
      setError(null);
    }
  }, [open]);

  // A device signed out, or cut off from elsewhere, can no longer speak for the account.
  if (!open || !account || account.revoked) return null;
  const close = () => !busy && useEmailDialog.setState({ open: false });

  const typed = email.trim().toLowerCase();
  const same = typed === account.email;
  const ready = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(typed) && !same && password !== "";
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const stored = await api.cloudChangeEmail(password, typed);
      await useVault.getState().refresh();
      useEmailDialog.setState({ open: false });
      toast("success", t("account.email.done", { email: stored }));
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const problem =
    error?.code === "bad_credentials"
      ? t("account.email.wrong_password")
      : error?.code === "account_exists"
        ? t("account.email.taken")
        : error
          ? `${errorText(error)}${error.detail ? `: ${error.detail}` : ""}`
          : null;

  return (
    <Modal
      title={t("account.email.title")}
      icon={<AtSign size={17} />}
      onClose={close}
      onSubmit={() => void save()}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={close}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !ready}>
            {t("account.email.save")}
          </button>
        </>
      }
    >
      <p>{t("account.email.text", { email: account.email })}</p>
      <Field label={t("account.email.new")} error={same ? t("account.email.same") : null}>
        <input
          className="input"
          type="email"
          data-autofocus
          value={email}
          disabled={busy}
          placeholder="name@example.com"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="email"
          onChange={(e) => setEmail(e.target.value)}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
        />
        <EmailTypo email={email} typing={typing} onUse={setEmail} />
      </Field>
      <Field label={t("account.email.password")} hint={t("account.email.password.hint")}>
        <PasswordInput value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <p className="note">{t("account.email.note")}</p>
      {problem && (
        <div className="notice error">
          <AlertTriangle size={15} />
          <span className="selectable">{problem}</span>
        </div>
      )}
    </Modal>
  );
}
