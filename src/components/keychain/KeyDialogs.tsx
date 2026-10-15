import { AlertTriangle, KeyRound, Pencil, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { mutate } from "../../lib/actions";
import { api, asApiError, type KeyKind, type KeyView } from "../../lib/api";
import { errorText, useT, type MessageKey } from "../../lib/i18n";
import { useUi, useVault } from "../../lib/store";
import { Field, Modal, PasswordInput } from "../ui";

const KINDS: KeyKind[] = ["ed25519", "ecdsa_p256", "ecdsa_p384", "rsa4096"];

export function GenerateKeyDialog(props: { onClose: () => void }) {
  const t = useT();
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<KeyKind>("ed25519");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !label.trim()) return;
    setBusy(true);
    const key = await mutate(() => api.keyGenerate(kind, label), t("key.generated"));
    setBusy(false);
    if (key) props.onClose();
  };

  return (
    <Modal
      title={t("key.generate.title")}
      icon={<KeyRound size={17} />}
      onClose={() => !busy && props.onClose()}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !label.trim()}>
            {busy ? t("key.generating") : t("key.generate.action")}
          </button>
        </>
      }
    >
      <Field label={t("key.label")}>
        <input
          className="input"
          data-autofocus
          value={label}
          placeholder="MacBook"
          onChange={(e) => setLabel(e.target.value)}
          spellCheck={false}
        />
      </Field>
      <Field label={t("key.type")}>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as KeyKind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`key.type.${k}` as MessageKey)}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

export function ImportKeyDialog(props: { onClose: () => void }) {
  const t = useT();
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [savePassphrase, setSavePassphrase] = useState(true);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    // Private keys are a few kilobytes; anything large is the wrong file.
    if (file.size > 64 * 1024) {
      setError(t("error.key"));
      return;
    }
    setText(await file.text());
    setError(null);
    setNeedsPassphrase(false);
    if (!label.trim()) setLabel(file.name.replace(/\.(pem|ppk|key)$/i, ""));
  };

  const submit = async () => {
    if (busy || !text.trim() || !label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.keyImport(text, passphrase || null, savePassphrase, label);
      await useVault.getState().refresh();
      useUi.getState().toast("success", t("key.imported"));
      props.onClose();
    } catch (e) {
      const failure = asApiError(e);
      if (failure.code === "key_encrypted") {
        setNeedsPassphrase(true);
        setError(null);
      } else if (failure.code === "key" && needsPassphrase && passphrase) {
        setError(t("prompt.passphrase.retry"));
      } else {
        const title = errorText(failure);
        setError(failure.detail ? `${title}: ${failure.detail}` : title);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={t("key.import.title")}
      icon={<Upload size={17} />}
      onClose={() => !busy && props.onClose()}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            {t("key.import.file")}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" disabled={busy} onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !text.trim() || !label.trim()}>
            {t("key.import.action")}
          </button>
        </>
      }
    >
      <input
        ref={fileRef}
        type="file"
        hidden
        onChange={(e) => {
          void readFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <Field label={t("key.label")}>
        <input
          className="input"
          data-autofocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          spellCheck={false}
        />
      </Field>
      <Field label={t("key.import.text")}>
        <textarea
          className="textarea"
          value={text}
          placeholder={t("key.import.placeholder")}
          onChange={(e) => {
            setText(e.target.value);
            setNeedsPassphrase(false);
            setError(null);
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>
      {needsPassphrase && (
        <>
          <Field label={t("key.import.passphrase")} hint={t("error.key_encrypted")}>
            <PasswordInput autoFocus value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={savePassphrase}
              onChange={(e) => setSavePassphrase(e.target.checked)}
            />
            {t("key.import.save_passphrase")}
          </label>
        </>
      )}
      {error && (
        <div className="notice error">
          <AlertTriangle size={15} />
          <span className="selectable">{error}</span>
        </div>
      )}
    </Modal>
  );
}

export function RenameKeyDialog(props: { keyView: KeyView; onClose: () => void }) {
  const t = useT();
  const [label, setLabel] = useState(props.keyView.label);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !label.trim()) return;
    setBusy(true);
    const key = await mutate(() => api.keyRename(props.keyView.id, label), t("key.renamed"));
    setBusy(false);
    if (key) props.onClose();
  };

  return (
    <Modal
      title={t("common.rename")}
      icon={<Pencil size={17} />}
      onClose={props.onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !label.trim()}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <Field label={t("key.label")}>
        <input
          className="input"
          data-autofocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          spellCheck={false}
        />
      </Field>
    </Modal>
  );
}
