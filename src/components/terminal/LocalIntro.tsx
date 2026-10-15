import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { WINDOWS } from "../../lib/platform";
import type { Tab } from "../../lib/store";
import { cx } from "../ui";

/** Long enough to be seen, short enough not to wait for. */
const SHOWN_MS = 420;
const LEAVING_MS = 220;

/**
 * The local terminal's own short start: the mark with its cursor and
 * "This Mac", while the shell starts, then it fades into the terminal.
 * There is nothing to connect to and nothing to sign in to.
 */
export function LocalIntro({ tab, onDone }: { tab: Tab; onDone: () => void }) {
  const t = useT();
  const [shownLongEnough, setShownLongEnough] = useState(false);
  const leaving = shownLongEnough && tab.status !== "connecting";

  useEffect(() => {
    const timer = window.setTimeout(() => setShownLongEnough(true), SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onDone, LEAVING_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onDone]);

  return (
    <div className={cx("local-intro", leaving && "leaving")} aria-hidden>
      <svg viewBox="0 0 64 64" width="48" height="48">
        <rect width="64" height="64" rx="15" fill="var(--bg-3)" />
        <path
          className="local-intro-chevron"
          d="M18 23 L30 32 L18 41"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect className="local-intro-cursor" x="34" y="38.5" width="14" height="5" rx="2.5" fill="var(--text)" />
      </svg>
      <div className="local-intro-title">{t(WINDOWS ? "local.this_pc" : "local.this_mac")}</div>
    </div>
  );
}
