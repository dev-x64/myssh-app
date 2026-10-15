import { SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";
import { mutate } from "../../lib/actions";
import { api, type Snippet } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useVault } from "../../lib/store";
import { Field, Modal } from "../ui";

export function SnippetDialog(props: {
  snippet: Snippet | null;
  /** For a new snippet: the command to start from. */
  script?: string;
  onClose: () => void;
}) {
  const t = useT();
  const snippets = useVault((s) => s.snapshot.snippets);
  const [name, setName] = useState(props.snippet?.name ?? "");
  const [group, setGroup] = useState(props.snippet?.package ?? "");
  const [description, setDescription] = useState(props.snippet?.description ?? "");
  const [script, setScript] = useState(props.snippet?.script ?? props.script ?? "");
  const [busy, setBusy] = useState(false);

  const groups = useMemo(
    () => [...new Set(snippets.map((s) => s.package).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [snippets],
  );
  const valid = name.trim() !== "" && script.trim() !== "";

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const saved = await mutate(
      () =>
        api.snippetSave({ id: props.snippet?.id ?? null, name, description, script, package: group }),
      t("snippet.saved"),
    );
    setBusy(false);
    if (saved) props.onClose();
  };

  return (
    <Modal
      wide
      title={props.snippet ? t("snippet.edit") : t("snippet.new")}
      icon={<SquareTerminal size={17} />}
      onClose={props.onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!valid || busy}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="row">
        <div className="grow">
          <Field label={t("snippet.name")}>
            <input
              className="input"
              data-autofocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
            />
          </Field>
        </div>
        <div style={{ width: 170 }}>
          <Field label={t("snippet.package")} optional>
            <input
              className="input"
              list="snippet-groups"
              value={group}
              title={t("snippet.package.hint")}
              onChange={(e) => setGroup(e.target.value)}
              spellCheck={false}
            />
            <datalist id="snippet-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
        </div>
      </div>
      <Field label={t("snippet.description")} optional>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label={t("snippet.script")} hint={t("snippet.script.hint")}>
        <textarea
          className="textarea"
          value={script}
          placeholder={"sudo systemctl restart nginx"}
          onChange={(e) => setScript(e.target.value)}
          // Enter adds a line here; the dialog is submitted with the button.
          onKeyDown={(e) => e.key === "Enter" && e.stopPropagation()}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>
    </Modal>
  );
}
