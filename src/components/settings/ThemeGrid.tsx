import { useT } from "../../lib/i18n";
import { isDark, useSettings } from "../../lib/settings";
import { resolveTermTheme, TERM_THEMES, type TermTheme } from "../../lib/themes";
import { cx } from "../ui";

/** A colour scheme as a small terminal of its own: its background, a prompt and a few coloured words. */
function ThemeCard(props: { name: string; theme: TermTheme; on: boolean; onPick: () => void }) {
  const c = props.theme.colors;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.on}
      className={cx("theme-card", props.on && "on")}
      title={props.name}
      onClick={props.onPick}
    >
      <span className="theme-mini" style={{ background: c.background, color: c.foreground }}>
        <span>
          <b style={{ color: c.green }}>~</b>
          <b style={{ color: c.blue }}>$</b> ls
        </span>
        <span>
          <b style={{ color: c.blue }}>app</b> <b style={{ color: c.green }}>run.sh</b>
        </span>
        <span>
          <b style={{ color: c.red }}>err</b> <b style={{ color: c.yellow }}>warn</b>
        </span>
      </span>
      <span className="theme-name">{props.name}</span>
    </button>
  );
}

/** The terminal's colour schemes, picked by sight: at setup, and smaller in Settings. */
export function ThemeGrid({ small }: { small?: boolean }) {
  const t = useT();
  const s = useSettings();
  const auto = resolveTermTheme("auto", isDark(s.theme));
  return (
    <div className={cx("theme-grid", small && "small")} role="radiogroup" aria-label={t("settings.term_theme")}>
      <ThemeCard
        name={t("setup.theme.auto")}
        theme={auto}
        on={s.termTheme === "auto"}
        onPick={() => s.set({ termTheme: "auto" })}
      />
      {TERM_THEMES.map((item) => (
        <ThemeCard
          key={item.id}
          name={item.name}
          theme={item}
          on={s.termTheme === item.id}
          onPick={() => s.set({ termTheme: item.id })}
        />
      ))}
    </div>
  );
}
