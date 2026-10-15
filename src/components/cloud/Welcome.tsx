import { ChevronRight } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useSettings } from "../../lib/settings";
import { SecurityNotes } from "./SecurityNotes";
import { SignInForm } from "./SignInForm";

/**
 * Shown the first time the app is opened: sign in, create an account, or
 * carry on without one. The app is fully usable either way.
 */
export function Welcome() {
  const t = useT();
  return (
    <div className="welcome">
      {/* Something quiet going on behind: two slow lights and a faint grid. */}
      <div className="welcome-glow" aria-hidden>
        <i />
        <i />
      </div>
      <div className="welcome-body scroll">
      <div className="welcome-layout">
      <div className="welcome-box">
        <div className="welcome-logo" aria-hidden>
          <svg viewBox="0 0 64 64" width="56" height="56">
            <rect width="64" height="64" rx="15" fill="var(--bg-3)" />
            <path
              d="M18 23 L30 32 L18 41"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <rect className="welcome-cursor" x="34" y="38.5" width="14" height="5" rx="2.5" fill="var(--text)" />
          </svg>
        </div>
        <h1>{t("welcome.title")}</h1>
        <p className="muted">{t("welcome.text")}</p>
        <SignInForm autoFocus />
        <button className="btn ghost welcome-skip" onClick={() => useSettings.getState().set({ welcomed: true })}>
          {t("welcome.skip")}
          <ChevronRight size={15} />
        </button>
        <p className="dim">{t("welcome.skip.hint")}</p>
      </div>
      <SecurityNotes />
      </div>
      </div>
    </div>
  );
}
