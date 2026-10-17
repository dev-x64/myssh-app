import { Lightbulb, X } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { cx } from "./ui";

/** Every tip there is, so that showing them again can be offered when any was seen. */
export type TipId = "hosts" | "terminal" | "files" | "forwards" | "keychain" | "snippets";

/**
 * A word for someone new, where they are about to need it: shown until it
 * is understood, then never again. All of them can be turned off at once,
 * here or in Settings, and brought back from there.
 */
export function Tip(props: {
  id: TipId;
  title: string;
  children: ReactNode;
  className?: string;
  /** A small drawing of the thing being explained, above the words. */
  art?: ReactNode;
}) {
  const t = useT();
  const shown = useSettings((s) => s.tips && !s.tipsSeen.includes(props.id));
  if (!shown) return null;
  const seen = () => {
    const s = useSettings.getState();
    s.set({ tipsSeen: [...s.tipsSeen.filter((id) => id !== props.id), props.id] });
  };
  return (
    <div className={cx("tip", props.className)} role="note">
      <span className="tip-icon">
        <Lightbulb size={15} />
      </span>
      <div className="tip-body">
        <b>{props.title}</b>
        {props.art}
        <div className="tip-text">{props.children}</div>
        <div className="tip-actions">
          <button type="button" className="btn small" onClick={seen}>
            {t("tip.ok")}
          </button>
          <button type="button" className="link-button" onClick={() => useSettings.getState().set({ tips: false })}>
            {t("tip.off")}
          </button>
        </div>
      </div>
      <button type="button" className="btn ghost icon small tip-close" aria-label={t("common.close")} onClick={seen}>
        <X size={13} />
      </button>
    </div>
  );
}
