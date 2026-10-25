import { Sparkles } from "lucide-react";
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { SELLS_PRO } from "../../lib/platform";
import { cx } from "../ui";
import { openAccountPage } from "./status";

/** The mark of Pro: beside an account that has it, or a feature that needs it. */
export function ProBadge({ className }: { className?: string }) {
  return (
    <span className={cx("pro-badge", className)}>
      <Sparkles size={10} />
      Pro
    </span>
  );
}

/**
 * The way to Pro: the account's subscription page, opened in the browser
 * already signed in. `onOpen` runs first, to close whatever it sits in.
 * Where the app sells nothing (Android), only where Pro is to be had, in
 * words, with no link.
 */
export function GetProButton({ small, onOpen }: { small?: boolean; onOpen?: () => void }) {
  const t = useT();
  const [opening, setOpening] = useState(false);
  if (!SELLS_PRO) return <span className="pro-elsewhere">{t("cloud.pro_elsewhere")}</span>;
  return (
    <button
      className={cx("btn primary pro-button", small && "small")}
      disabled={opening}
      title={t("cloud.plan.open.hint")}
      onClick={async () => {
        onOpen?.();
        setOpening(true);
        await openAccountPage();
        setOpening(false);
      }}
    >
      <Sparkles size={small ? 13 : 14} />
      {t("cloud.get_pro")}
    </button>
  );
}
