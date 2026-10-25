import { useState } from "react";
import { useT } from "../lib/i18n";
import type { Tab } from "../lib/store";
import { Field, Modal } from "./ui";

/** A tab's name, changed: for telling apart two terminals on one host. */
export function RenameTab(props: { tab: Tab; onDone: (title: string | null) => void }) {
  const t = useT();
  const [title, setTitle] = useState(props.tab.title);
  return (
    <Modal
      title={t("tab.rename.title")}
      onClose={() => props.onDone(null)}
      onSubmit={() => props.onDone(title.trim() || null)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => props.onDone(null)}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!title.trim()}>
            {t("common.rename")}
          </button>
        </>
      }
    >
      <Field label={t("tab.rename.label")}>
        <input
          className="input"
          data-autofocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={(e) => e.target.select()}
          spellCheck={false}
        />
      </Field>
    </Modal>
  );
}
