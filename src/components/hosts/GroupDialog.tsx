import { Folder } from "lucide-react";
import { useState } from "react";
import { mutate } from "../../lib/actions";
import { api, type Group, type Id } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { Field, Modal } from "../ui";

/** Creates a group under `parentId`, or renames `group`. */
export function GroupDialog(props: { group: Group | null; parentId: Id | null; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(props.group?.name ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const saved = await mutate(() =>
      api.groupSave({
        id: props.group?.id ?? null,
        name,
        parent_id: props.group ? props.group.parent_id : props.parentId,
      }),
    );
    setBusy(false);
    if (saved) props.onClose();
  };

  return (
    <Modal
      title={props.group ? t("group.edit") : t("group.new")}
      icon={<Folder size={17} />}
      onClose={props.onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || busy}>
            {props.group ? t("common.save") : t("common.create")}
          </button>
        </>
      }
    >
      <Field label={t("group.name")}>
        <input
          className="input"
          data-autofocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
        />
      </Field>
    </Modal>
  );
}
