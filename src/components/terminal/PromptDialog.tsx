import { KeyRound, ShieldAlert, ShieldQuestion, UserRound } from "lucide-react";
import { useState } from "react";
import type { Prompt, PromptReply } from "../../lib/api";
import { formatDate, useT } from "../../lib/i18n";
import { useSettings } from "../../lib/settings";
import { Field, Modal } from "../ui";

interface Props<P extends Prompt = Prompt> {
  prompt: P;
  onReply: (reply: PromptReply) => void;
  /** Where the dialog sits: over its terminal tab (default) or the window. */
  scope?: "tab" | "window";
}

const cancel: PromptReply = { kind: "cancel" };

function HostKeyPrompt({ prompt, onReply, scope = "tab" }: Props<Extract<Prompt, { kind: "host_key" }>>) {
  const t = useT();
  const locale = useSettings((s) => s.locale);
  const changed = prompt.known.length > 0;
  const host = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;

  return (
    <Modal
      scope={scope}
      wide
      danger={changed}
      title={t(changed ? "prompt.hostkey.changed.title" : "prompt.hostkey.new.title")}
      icon={changed ? <ShieldAlert size={17} /> : <ShieldQuestion size={17} />}
      onClose={() => onReply(cancel)}
      // A changed key must be accepted deliberately, never by pressing Enter.
      onSubmit={changed ? undefined : () => onReply({ kind: "accept" })}
      footer={
        changed ? (
          <>
            <button type="button" className="btn danger" onClick={() => onReply({ kind: "accept" })}>
              {t("prompt.hostkey.replace")}
            </button>
            <button type="button" className="btn primary" data-autofocus onClick={() => onReply(cancel)}>
              {t("prompt.hostkey.reject")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => onReply(cancel)}>
              {t("prompt.hostkey.reject")}
            </button>
            <button type="submit" className="btn primary" data-autofocus>
              {t("prompt.hostkey.accept")}
            </button>
          </>
        )
      }
    >
      <p>{t(changed ? "prompt.hostkey.changed.text" : "prompt.hostkey.new.text", { host })}</p>
      <div className="keybox">
        <span className="cap">
          {t("prompt.hostkey.presented")} · {prompt.algorithm}
        </span>
        <span className="mono selectable">{prompt.fingerprint}</span>
      </div>
      {prompt.known.map((known) => (
        <div key={known.fingerprint} className="keybox old">
          <span className="cap">
            {t("prompt.hostkey.trusted")} · {known.algorithm} · {formatDate(known.added_at, locale)}
          </span>
          <span className="mono selectable">{known.fingerprint}</span>
        </div>
      ))}
    </Modal>
  );
}

/** One text answer with an optional "remember" choice. */
function TextPrompt(props: {
  title: string;
  text: string;
  retry?: string | null;
  secret: boolean;
  rememberLabel: string;
  icon: React.ReactNode;
  scope: "tab" | "window";
  onReply: (reply: PromptReply) => void;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);

  return (
    <Modal
      scope={props.scope}
      title={props.title}
      icon={props.icon}
      onClose={() => props.onReply(cancel)}
      onSubmit={() => value && props.onReply({ kind: "text", value, remember })}
      footer={
        <>
          <button type="button" className="btn" onClick={() => props.onReply(cancel)}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!value}>
            {t("common.continue")}
          </button>
        </>
      }
    >
      <Field label={props.text} error={props.retry}>
        <input
          className="input"
          data-autofocus
          type={props.secret ? "password" : "text"}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        {props.rememberLabel}
      </label>
    </Modal>
  );
}

function InteractivePrompt({
  prompt,
  onReply,
  scope = "tab",
}: Props<Extract<Prompt, { kind: "keyboard_interactive" }>>) {
  const t = useT();
  const [values, setValues] = useState<string[]>(() => prompt.prompts.map(() => ""));

  return (
    <Modal
      scope={scope}
      title={prompt.name.trim() || t("prompt.interactive.title")}
      icon={<KeyRound size={17} />}
      onClose={() => onReply(cancel)}
      onSubmit={() => onReply({ kind: "answers", values })}
      footer={
        <>
          <button type="button" className="btn" onClick={() => onReply(cancel)}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary">
            {t("common.continue")}
          </button>
        </>
      }
    >
      {prompt.instructions.trim() && <p className="selectable">{prompt.instructions}</p>}
      {prompt.prompts.map((question, index) => (
        <Field key={index} label={question.prompt.trim().replace(/:$/, "") || "…"}>
          <input
            className="input"
            {...(index === 0 ? { "data-autofocus": true } : {})}
            type={question.echo ? "text" : "password"}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={values[index]}
            onChange={(e) => setValues(values.map((v, i) => (i === index ? e.target.value : v)))}
          />
        </Field>
      ))}
    </Modal>
  );
}

export function PromptDialog({ prompt, onReply, scope = "tab" }: Props) {
  const t = useT();
  switch (prompt.kind) {
    case "host_key":
      return <HostKeyPrompt prompt={prompt} onReply={onReply} scope={scope} />;
    case "username":
      return (
        <TextPrompt
          title={t("prompt.username.title")}
          text={t("prompt.username.text")}
          secret={false}
          rememberLabel={t("prompt.username.remember")}
          icon={<UserRound size={17} />}
          scope={scope}
          onReply={onReply}
        />
      );
    case "password":
      return (
        <TextPrompt
          title={t("prompt.password.title")}
          text={t("prompt.password.text", { user: prompt.username })}
          retry={prompt.attempt > 1 ? t("prompt.password.retry") : null}
          secret
          rememberLabel={t("prompt.password.remember")}
          icon={<KeyRound size={17} />}
          scope={scope}
          onReply={onReply}
        />
      );
    case "key_passphrase":
      return (
        <TextPrompt
          title={t("prompt.passphrase.title")}
          text={t("prompt.passphrase.text", { key: prompt.key_label })}
          retry={prompt.attempt > 1 ? t("prompt.passphrase.retry") : null}
          secret
          rememberLabel={t("prompt.passphrase.remember")}
          icon={<KeyRound size={17} />}
          scope={scope}
          onReply={onReply}
        />
      );
    case "keyboard_interactive":
      return <InteractivePrompt prompt={prompt} onReply={onReply} scope={scope} />;
  }
}
