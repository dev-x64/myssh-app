// Copying from a terminal on a phone. The terminal draws its text on a
// canvas, where a finger can select nothing; here the same text is plain,
// and the phone's own selection, with its handles, works on it.

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, CopyCheck } from "lucide-react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useT } from "../../lib/i18n";
import { getSession } from "../../lib/sessions";
import { useUi, type Tab } from "../../lib/store";
import { Sheet } from "../ui";

export function SelectText({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const t = useT();
  const text = useMemo(() => getSession(tab.id)?.plainText() ?? "", [tab.id]);
  const pre = useRef<HTMLPreElement>(null);

  // The end of the output is what is wanted most often: it is in sight first.
  useLayoutEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, []);

  const copy = async (what: string) => {
    if (!what) return;
    try {
      await writeText(what);
      useUi.getState().toast("success", t("mobile.copied"));
      onClose();
    } catch {
      // The clipboard refused; the text stays up to be tried again.
    }
  };

  return (
    <Sheet title={t("mobile.term.select")} className="m-select" onClose={onClose}>
      <p className="m-select-hint">{t("mobile.select.hint")}</p>
      <pre ref={pre} className="m-select-text selectable">
        {text}
      </pre>
      <div className="m-select-actions">
        <button className="btn" onClick={() => void copy(text)}>
          <CopyCheck size={17} />
          {t("mobile.select.copy_all")}
        </button>
        <button className="btn primary" onClick={() => void copy(window.getSelection()?.toString() ?? "")}>
          <Copy size={17} />
          {t("mobile.select.copy")}
        </button>
      </div>
    </Sheet>
  );
}
