import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { api, asApiError } from "../../lib/api";
import { syncNow } from "../../lib/cloud";
import { errorText, useT } from "../../lib/i18n";
import { passwordStrength } from "../../lib/strength";
import { useSettings } from "../../lib/settings";
import { useVault } from "../../lib/store";
import { Field, PasswordInput, Segmented } from "../ui";
import { EmailTypo } from "./EmailTypo";
import { ServerStatus, useCloudCheck } from "./ServerStatus";

/** The same shape the core and the server accept. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sign in to the cloud, or create an account. The login is an e-mail. */
/**
 * A fine line under the field where a master password is chosen: how hard
 * it would be to guess, filling and changing colour as it is typed.
 */
function StrengthLine({ password }: { password: string }) {
  const t = useT();
  const level = passwordStrength(password);
  return (
    <div className="strength" data-level={level} aria-live="polite">
      <div className="strength-track">
        <span style={{ width: `${level * 25}%` }} />
      </div>
      <span className="strength-label">{level === 0 ? "" : t(`strength.${level}`)}</span>
    </div>
  );
}

export function SignInForm(props: { autoFocus?: boolean }) {
  const t = useT();
  const [mode, setMode] = useState<"sign_in" | "sign_up">("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [touched, setTouched] = useState(false);
  const [typingEmail, setTypingEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The server said there is no account with this e-mail. */
  const [noAccount, setNoAccount] = useState(false);

  const server = useCloudCheck();
  const creating = mode === "sign_up";
  // Known for sure that this server takes no new accounts.
  const closed = creating && server.check?.online === true && !server.check.registration_open;
  const emailValid = EMAIL.test(email.trim());
  const short = creating && password.length > 0 && password.length < 10;
  const mismatch = creating && again.length > 0 && again !== password;
  const ready =
    emailValid && password !== "" && (!creating || (password.length >= 10 && again === password));

  const submit = async () => {
    setTouched(true);
    if (!ready || busy || closed) return;
    setBusy(true);
    setError(null);
    setNoAccount(false);
    try {
      if (creating) await api.cloudSignUp(email.trim(), password);
      else await api.cloudSignIn(email.trim(), password);
      setPassword("");
      setAgain("");
      // Signed in: the first-launch screen has done its job.
      useSettings.getState().set({ welcomed: true });
      await useVault.getState().refresh();
      void syncNow();
    } catch (e) {
      const failure = asApiError(e);
      const text = errorText(failure);
      setError(failure.detail ? `${text}: ${failure.detail}` : text);
      setNoAccount(failure.code === "no_account");
      if (failure.code === "offline") void server.recheck();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="cloud-form"
      // Validation is ours, so the messages are ours and in the UI language.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <ServerStatus {...server} />
      <Segmented
        value={mode}
        onChange={(value) => {
          setMode(value);
          setError(null);
          setNoAccount(false);
        }}
        options={[
          { value: "sign_in", label: t("cloud.mode.sign_in") },
          { value: "sign_up", label: t("cloud.mode.sign_up") },
        ]}
      />
      <Field
        label={t("cloud.email")}
        error={touched && email.trim() !== "" && !emailValid ? t("cloud.email.invalid") : null}
      >
        <input
          className="input"
          type="email"
          inputMode="email"
          autoFocus={props.autoFocus}
          value={email}
          placeholder="you@example.com"
          onChange={(e) => {
            setEmail(e.target.value);
            // The complaint was about the address as it was.
            if (noAccount) {
              setNoAccount(false);
              setError(null);
            }
          }}
          onFocus={() => setTypingEmail(true)}
          onBlur={() => {
            setTouched(true);
            setTypingEmail(false);
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <EmailTypo email={email} typing={typingEmail} onUse={setEmail} />
      </Field>
      <Field label={t("cloud.password")} error={short ? t("cloud.password.short") : null}>
        <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} />
        {creating && <StrengthLine password={password} />}
      </Field>
      {creating && (
        <>
          <Field label={t("cloud.password.again")} error={mismatch ? t("cloud.password.mismatch") : null}>
            <PasswordInput value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          <div className="notice keep">
            <AlertTriangle size={15} />
            <div>
              <strong>{t("cloud.password.keep")}</strong>
              <ul>
                <li>{t("cloud.password.keep.yours")}</li>
                <li>{t("cloud.password.keep.lost")}</li>
                <li>{t("cloud.password.keep.where")}</li>
              </ul>
            </div>
          </div>
        </>
      )}
      {closed && (
        <div className="notice">
          <AlertTriangle size={15} />
          <span>{t("cloud.registration_closed")}</span>
        </div>
      )}
      {error && (
        <div className="notice error">
          <AlertTriangle size={15} />
          <span className="selectable">
            {error}
            {noAccount && (
              <>
                {" "}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    // The address stays; the password is asked twice there.
                    setMode("sign_up");
                    setError(null);
                    setNoAccount(false);
                  }}
                >
                  {t("cloud.no_account.create")}
                </button>
              </>
            )}
          </span>
        </div>
      )}
      <button
        type="submit"
        className="btn primary"
        disabled={busy || closed || email.trim() === "" || password === ""}
      >
        {busy ? t("cloud.signing_in") : t(creating ? "cloud.sign_up" : "cloud.sign_in")}
      </button>
      <span className="dim">{t("cloud.merge_note")}</span>
    </form>
  );
}
