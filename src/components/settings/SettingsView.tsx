import { Minus, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useT, type Locale } from "../../lib/i18n";
import {
  ACCENT_COLOR,
  ACCENTS,
  CURSOR_COLORS,
  cursorColorOf,
  isDark,
  FONT_CHOICES,
  FONT_SIZE,
  useSettings,
  type AppTheme,
  type CursorStyle,
} from "../../lib/settings";
import { reportError } from "../../lib/actions";
import { api } from "../../lib/api";
import { usePlan } from "../../lib/plan";
import { useUi, useVault } from "../../lib/store";
import { ANDROID, WINDOWS } from "../../lib/platform";
import { useUpdate } from "../../lib/update";
import { resolveTermTheme } from "../../lib/themes";
import { cx, Segmented, Switch } from "../ui";
import { DeleteAccount } from "./DeleteAccount";
import { SecuritySection } from "./SecuritySection";
import { SharingSection } from "./SharingSection";
import { MenuEntrySetting } from "../MenuEntry";
import { TerminalSample } from "./TerminalSample";
import { ThemeGrid } from "./ThemeGrid";

export function Setting(props: { name: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-text">
        <div className="name">{props.name}</div>
        {props.hint && <div className="hint">{props.hint}</div>}
      </div>
      <div className="control">{props.children}</div>
    </div>
  );
}

/** A setting that belongs to the one above it, set in a little. */
function SubSetting(props: { name: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting sub">
      <div className="setting-text">
        <div className="name">{props.name}</div>
        {props.hint && <div className="hint">{props.hint}</div>}
      </div>
      <div className="control">{props.children}</div>
    </div>
  );
}

export function Stepper(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const clamp = (v: number) => Math.min(props.max, Math.max(props.min, Math.round(v * 100) / 100));
  return (
    <div className="stepper">
      <button
        type="button"
        disabled={props.value <= props.min}
        onClick={() => props.onChange(clamp(props.value - props.step))}
      >
        <Minus size={14} />
      </button>
      <span>{props.format ? props.format(props.value) : props.value}</span>
      <button
        type="button"
        disabled={props.value >= props.max}
        onClick={() => props.onChange(clamp(props.value + props.step))}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

const SCROLLBACK = [1000, 5000, 10000, 50000, 100000];

export function SettingsView() {
  const t = useT();
  const s = useSettings();
  // Shown only while the server has AI suggestions on for this account.
  const ai = usePlan((p) => p.plan?.ai === true);
  // The scheme's own colours, for the cursor swatches.
  const schemeColors = resolveTermTheme(s.termTheme, isDark(s.theme)).colors;
  const status = useVault((v) => v.status);
  const toast = useUi((u) => u.toast);
  const update = useUpdate();

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("settings.title")}</h1>
      </div>
      <div className="page-body scroll">
        <div className="settings">
          <div className="section-title">{t("settings.appearance")}</div>
          <div className="table">
            <Setting name={t("settings.language")}>
              <Segmented<Locale>
                value={s.locale}
                onChange={(locale) => s.set({ locale })}
                options={[
                  { value: "ru", label: "Русский" },
                  { value: "en", label: "English" },
                ]}
              />
            </Setting>
            <Setting name={t("settings.tips")} hint={t("settings.tips.hint")}>
              <div className="setting-tips">
                {s.tipsSeen.length > 0 && (
                  <button className="btn small" onClick={() => s.set({ tips: true, tipsSeen: [] })}>
                    {t("settings.tips.again")}
                  </button>
                )}
                <Switch on={s.tips} onChange={(tips) => s.set({ tips })} label={t("settings.tips")} />
              </div>
            </Setting>
            <Setting name={t("settings.theme")}>
              <Segmented<AppTheme>
                value={s.theme}
                onChange={(value) => s.set({ theme: value })}
                options={[
                  { value: "dark", label: t("settings.theme.dark") },
                  { value: "light", label: t("settings.theme.light") },
                  { value: "system", label: t("settings.theme.system") },
                ]}
              />
            </Setting>
            <Setting name={t("settings.accent")}>
              <div className="swatches" role="radiogroup" aria-label={t("settings.accent")}>
                {ACCENTS.map((accent) => (
                  <button
                    key={accent}
                    type="button"
                    role="radio"
                    aria-checked={s.accent === accent}
                    className={s.accent === accent ? "swatch on" : "swatch"}
                    style={{ background: ACCENT_COLOR[accent] }}
                    title={t(`accent.${accent}`)}
                    onClick={() => s.set({ accent })}
                  />
                ))}
              </div>
            </Setting>
          </div>

          <div className="section-title">{t("settings.terminal")}</div>
          {/* The sample stands beside what changes it, and stays in sight while that is scrolled through. */}
          <div className="with-preview">
            <div className="table">
              <div className="setting stacked">
                <div className="setting-text">
                  <div className="name">{t("settings.term_theme")}</div>
                </div>
                <ThemeGrid small />
              </div>
              <Setting name={t("settings.font")}>
                <select
                  className="select"
                  value={s.fontFamily}
                  onChange={(e) => s.set({ fontFamily: e.target.value })}
                >
                  {FONT_CHOICES.map((font) => (
                    <option key={font.id} value={font.id}>
                      {font.id}
                    </option>
                  ))}
                </select>
              </Setting>
              <Setting name={t("settings.font_size")}>
                <Stepper
                  value={s.fontSize}
                  min={FONT_SIZE.min}
                  max={FONT_SIZE.max}
                  step={1}
                  onChange={(fontSize) => s.set({ fontSize })}
                />
              </Setting>
              <Setting name={t("settings.line_height")}>
                <Stepper
                  value={s.lineHeight}
                  min={1}
                  max={1.8}
                  step={0.05}
                  format={(v) => v.toFixed(2)}
                  onChange={(lineHeight) => s.set({ lineHeight })}
                />
              </Setting>
              <Setting name={t("settings.cursor")}>
                <Segmented<CursorStyle>
                  value={s.cursorStyle}
                  onChange={(cursorStyle) => s.set({ cursorStyle })}
                  options={[
                    { value: "block", label: t("settings.cursor.block") },
                    { value: "bar", label: t("settings.cursor.bar") },
                    { value: "underline", label: t("settings.cursor.underline") },
                  ]}
                />
              </Setting>
              <Setting name={t("settings.cursor_color")}>
                <div className="swatches" role="radiogroup" aria-label={t("settings.cursor_color")}>
                  {CURSOR_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      role="radio"
                      aria-checked={s.cursorColor === color}
                      className={cx("swatch", color === "scheme" && "auto", s.cursorColor === color && "on")}
                      style={{ background: cursorColorOf(color, schemeColors) }}
                      title={t(color === "scheme" ? "settings.cursor_color.scheme" : color === "text" ? "settings.cursor_color.text" : `accent.${color}`)}
                      onClick={() => s.set({ cursorColor: color })}
                    />
                  ))}
                </div>
              </Setting>
              <Setting name={t("settings.cursor_blink")}>
                <Switch on={s.cursorBlink} onChange={(cursorBlink) => s.set({ cursorBlink })} />
              </Setting>
              <Setting name={t("settings.scrollback")}>
                <select
                  className="select"
                  value={s.scrollback}
                  onChange={(e) => s.set({ scrollback: Number(e.target.value) })}
                >
                  {SCROLLBACK.map((lines) => (
                    <option key={lines} value={lines}>
                      {lines.toLocaleString(s.locale === "ru" ? "ru-RU" : "en-US")}
                    </option>
                  ))}
                </select>
              </Setting>
              <Setting name={t("settings.copy_on_select")}>
                <Switch on={s.copyOnSelect} onChange={(copyOnSelect) => s.set({ copyOnSelect })} />
              </Setting>
              <Setting name={t("settings.highlight_ip")} hint={t("settings.highlight_ip.hint")}>
                <Switch on={s.highlightIp} onChange={(highlightIp) => s.set({ highlightIp })} />
              </Setting>
              <Setting name={t("settings.highlight_status")} hint={t("settings.highlight_status.hint")}>
                <Switch on={s.highlightStatus} onChange={(highlightStatus) => s.set({ highlightStatus })} />
              </Setting>
              <Setting name={t("settings.terminal_links")} hint={t("settings.terminal_links.hint")}>
                <Switch on={s.terminalLinks} onChange={(terminalLinks) => s.set({ terminalLinks })} />
              </Setting>
              <Setting name={t("settings.server_stats")} hint={t("settings.server_stats.hint")}>
                <Switch on={s.serverStats} onChange={(serverStats) => s.set({ serverStats })} />
              </Setting>
              {s.serverStats && (
                <>
                  <SubSetting name={t("settings.stats_tiles")} hint={t("settings.stats_tiles.hint")}>
                    <Switch on={s.statsTiles} onChange={(statsTiles) => s.set({ statsTiles })} />
                  </SubSetting>
                  <SubSetting name={t("settings.stats_bar")} hint={t("settings.stats_bar.hint")}>
                    <Switch on={s.statsBar} onChange={(statsBar) => s.set({ statsBar })} />
                  </SubSetting>
                </>
              )}
              <Setting name={t("settings.suggestions")} hint={t("settings.suggestions.hint")}>
                <Switch on={s.suggestions} onChange={(suggestions) => s.set({ suggestions })} />
              </Setting>
              {ai && (
                <Setting name={t("settings.ai_suggestions")} hint={t("settings.ai_suggestions.hint")}>
                  <Switch
                    on={s.suggestions && s.aiSuggestions}
                    onChange={(aiSuggestions) => s.set(aiSuggestions ? { aiSuggestions, suggestions: true } : { aiSuggestions })}
                  />
                </Setting>
              )}
              <Setting name={t("settings.history_clear")}>
                <button
                  className="btn small"
                  onClick={() =>
                    void api
                      .historyClear(null)
                      .then(() => toast("success", t("settings.history_cleared")))
                      .catch(reportError)
                  }
                >
                  {t("settings.history_clear")}
                </button>
              </Setting>
            </div>
            <TerminalSample />
          </div>

          <div className="section-title">{t("settings.connection")}</div>
          <div className="table">
            <Setting name={t("settings.auto_reconnect")} hint={t("settings.auto_reconnect.hint")}>
              <Switch on={s.autoReconnect} onChange={(autoReconnect) => s.set({ autoReconnect })} />
            </Setting>
          </div>

          <div className="section-title">{t("settings.files")}</div>
          <div className="table">
            <Setting name={t("settings.files_follow")} hint={t("settings.files_follow.hint")}>
              <Switch
                on={s.filesFollowTerminal}
                onChange={(filesFollowTerminal) => s.set({ filesFollowTerminal })}
              />
            </Setting>
            <Setting name={t("settings.files_parent_row")} hint={t("settings.files_parent_row.hint")}>
              <Switch on={s.filesParentRow} onChange={(filesParentRow) => s.set({ filesParentRow })} />
            </Setting>
            <Setting name={t("settings.files_archive")} hint={t("settings.files_archive.hint")}>
              <Switch on={s.filesArchive} onChange={(filesArchive) => s.set({ filesArchive })} />
            </Setting>
          </div>

          <SharingSection />

          <SecuritySection />

          <div className="section-title">{t("settings.about")}</div>
          <div className="table">
            <MenuEntrySetting />
            <Setting
              name={t("settings.version")}
              hint={
                update.available
                  ? t("update.available", { version: update.available.version })
                  : status && !status.updates
                    ? t(WINDOWS || ANDROID ? "update.by_store" : "update.not_here")
                    : update.checkedAt
                      ? t("update.none")
                      : undefined
              }
            >
              <span className="muted">{status?.version ?? "—"}</span>
              {status && !status.updates ? null : update.available ? (
                <button className="btn small primary" onClick={() => update.setDialog(true)}>
                  {t("update.show")}
                </button>
              ) : (
                <button
                  className="btn small"
                  disabled={update.phase !== "idle"}
                  onClick={() =>
                    void update.check(false).then((found) => {
                      const error = useUpdate.getState().error;
                      if (found) useUpdate.getState().setDialog(true);
                      else if (error) reportError(error);
                    })
                  }
                >
                  {t(update.phase === "checking" ? "update.checking" : "update.check")}
                </button>
              )}
            </Setting>
            <div className="setting">
              <div className="setting-text">
                <div className="name">{t("settings.data_dir")}</div>
                <div className="hint mono selectable" style={{ whiteSpace: "normal", wordBreak: "break-all" }}>
                  {status?.data_dir ?? "—"}
                </div>
                <div className="hint">{t("settings.key_file")}</div>
                {status?.debug && <div className="hint">{t("settings.debug_build")}</div>}
              </div>
            </div>
          </div>

          <DeleteAccount />
        </div>
      </div>
    </div>
  );
}
