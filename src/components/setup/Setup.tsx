import { ArrowLeft, ChevronRight, Cloud, Users, WandSparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useT, type Locale } from "../../lib/i18n";
import { usePlan } from "../../lib/plan";
import { ACCENTS, ACCENT_COLOR, FONT_SIZE, useSettings, type AppTheme } from "../../lib/settings";
import { useVault } from "../../lib/store";
import { GetProButton, ProBadge } from "../cloud/Pro";
import { SignInForm } from "../cloud/SignInForm";
import { Setting, Stepper } from "../settings/SettingsView";
import { TerminalSample } from "../settings/TerminalSample";
import { ThemeGrid } from "../settings/ThemeGrid";
import { cx, Segmented, Switch } from "../ui";

type Step = "look" | "account";

/**
 * The first launch: the basics on one screen (language, theme, the
 * terminal), then what an account and Pro add, with the way to sign in or
 * to go on without one. Everything here is in Settings too, and every step
 * can be left as it is.
 */
export function Setup() {
  const t = useT();
  const cloud = useVault((s) => s.status?.cloud_available ?? false);
  const steps: Step[] = cloud ? ["look", "account"] : ["look"];
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const last = index === steps.length - 1;
  const finish = () => useSettings.getState().set({ setupDone: true, welcomed: true });

  return (
    <div className="welcome setup">
      <div className="welcome-glow" aria-hidden>
        <i />
        <i />
      </div>
      <div className="welcome-body scroll">
        <div className="setup-card" key={step}>
          <div className="setup-steps" aria-hidden>
            {steps.map((name, i) => (
              <i key={name} className={cx(i === index && "on", i < index && "done")} />
            ))}
          </div>
          {step === "look" && <LookStep />}
          {step === "account" && <AccountStep />}
          <div className="setup-nav">
            {index > 0 ? (
              <button className="btn ghost" onClick={() => setIndex(index - 1)}>
                <ArrowLeft size={15} />
                {t("setup.back")}
              </button>
            ) : (
              <button className="btn ghost" onClick={finish}>
                {t("setup.skip")}
              </button>
            )}
            {!(step === "account") && (
              <button className="btn primary" onClick={() => (last ? finish() : setIndex(index + 1))}>
                {last ? t("setup.done") : t("setup.next")}
                <ChevronRight size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepHead(props: { title: string; text: string }) {
  return (
    <div className="setup-head">
      <h1>{props.title}</h1>
      <p className="muted">{props.text}</p>
    </div>
  );
}

/** How the app and the terminal look, and what the terminal does as you type. */
function LookStep() {
  const t = useT();
  const s = useSettings();
  return (
    <>
      <StepHead title={t("setup.look.title")} text={t("setup.look.text")} />
      <ThemeGrid />
      <div className="setup-split">
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
          <Setting name={t("settings.theme")}>
            <Segmented<AppTheme>
              value={s.theme}
              onChange={(theme) => s.set({ theme })}
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
          <Setting name={t("settings.font_size")}>
            <Stepper
              value={s.fontSize}
              min={FONT_SIZE.min}
              max={FONT_SIZE.max}
              step={1}
              onChange={(fontSize) => s.set({ fontSize })}
            />
          </Setting>
          <Setting name={t("settings.suggestions")} hint={t("setup.suggestions.hint")}>
            <Switch on={s.suggestions} onChange={(suggestions) => s.set({ suggestions })} />
          </Setting>
          <Setting name={t("settings.server_stats")} hint={t("setup.server_stats.hint")}>
            <Switch on={s.serverStats} onChange={(serverStats) => s.set({ serverStats })} />
          </Setting>
        </div>
        <TerminalSample />
      </div>
    </>
  );
}

/** What Pro adds, said plainly; each is switched on from its own place once it is there. */
function ProFeature(props: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="setup-feature">
      <span className="setup-feature-icon">{props.icon}</span>
      <div>
        <div className="name">{props.title}</div>
        <div className="hint">{props.text}</div>
      </div>
    </div>
  );
}

function AccountStep() {
  const t = useT();
  const account = useVault((s) => s.snapshot.cloud);
  const plan = usePlan((s) => s.plan?.plan);
  const finish = () => useSettings.getState().set({ setupDone: true, welcomed: true });
  return (
    <>
      <StepHead title={t("setup.account.title")} text={t("setup.account.text")} />
      <div className="setup-split account">
        <div className="setup-pro">
          <div className="setup-pro-title">
            {t("setup.pro.title")}
            <ProBadge />
          </div>
          <ProFeature icon={<Cloud size={16} />} title={t("setup.pro.sync")} text={t("setup.pro.sync.text")} />
          <ProFeature icon={<Users size={16} />} title={t("setup.pro.share")} text={t("setup.pro.share.text")} />
          <ProFeature icon={<WandSparkles size={16} />} title={t("setup.pro.ai")} text={t("setup.pro.ai.text")} />
          <p className="setup-free">{t("setup.free")}</p>
        </div>
        <div className="setup-sign">
          {account ? (
            <div className="setup-signed">
              <div className="name">{t("setup.signed_in", { email: account.email })}</div>
              {plan === "free" && (
                <>
                  <div className="hint">{t("setup.signed_in.free")}</div>
                  <GetProButton />
                </>
              )}
              <button className="btn primary setup-finish" onClick={finish}>
                {t("setup.done")}
                <ChevronRight size={15} />
              </button>
            </div>
          ) : (
            <>
              <SignInForm />
              <button className="btn ghost welcome-skip" onClick={finish}>
                {t("welcome.skip")}
                <ChevronRight size={15} />
              </button>
              <p className="dim">{t("welcome.skip.hint")}</p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
