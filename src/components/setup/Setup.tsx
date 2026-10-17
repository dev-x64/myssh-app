import {
  ArrowLeft,
  Check,
  ChevronRight,
  Cloud,
  Download,
  Users,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type ImportSource } from "../../lib/api";
import { ImportDialog } from "../hosts/ImportDialog";
import { useT, type Locale } from "../../lib/i18n";
import { usePlan } from "../../lib/plan";
import {
  ACCENTS,
  ACCENT_COLOR,
  FONT_SIZE,
  useSettings,
  type AppTheme,
} from "../../lib/settings";
import { useVault } from "../../lib/store";
import { GetProButton, ProBadge } from "../cloud/Pro";
import { SignInForm } from "../cloud/SignInForm";
import { Setting, Stepper } from "../settings/SettingsView";
import { TerminalSample } from "../settings/TerminalSample";
import { ThemeGrid } from "../settings/ThemeGrid";
import { cx, Segmented, Switch } from "../ui";
import { introWanted, WelcomeIntro } from "./WelcomeIntro";

type Step = "look" | "account" | "import";

/** Sources with hosts that are not in MySSH yet. */
const offered = (sources: ImportSource[] | null) =>
  (sources ?? []).filter((source) => source.hosts.some((host) => !host.exists));

/**
 * The first launch: the basics on one screen (language, theme, the
 * terminal), then what an account and Pro add, with the way to sign in or
 * to go on without one. Everything here is in Settings too, and every step
 * can be left as it is.
 */
export function Setup() {
  const t = useT();
  const cloud = useVault((s) => s.status?.cloud_available ?? false);
  const hostCount = useVault((s) => s.snapshot.hosts.length);
  // What other apps on this computer hold, looked for while the first steps are read.
  const [found, setFound] = useState<ImportSource[] | null>(null);
  useEffect(() => {
    api.importScan().then(setFound, () => setFound([]));
  }, []);
  const [index, setIndex] = useState(0);
  // Bringing hosts over is offered when there are some to bring and none
  // here yet (signing in may have brought them); once shown, it stays.
  const [importing, setImporting] = useState(false);
  const withImport = importing || (offered(found).length > 0 && hostCount === 0);
  const steps: Step[] = [
    "look",
    ...(cloud ? (["account"] as Step[]) : []),
    ...(withImport ? (["import"] as Step[]) : []),
  ];
  const step = steps[index];
  const last = index === steps.length - 1;
  const finish = () =>
    useSettings.getState().set({ setupDone: true, welcomed: true });
  const next = () => {
    if (last) return finish();
    if (steps[index + 1] === "import") setImporting(true);
    setIndex(index + 1);
  };
  const [intro, setIntro] = useState(introWanted);
  const introDone = useCallback(() => setIntro(false), []);

  return (
    <div className="welcome setup">
      <div className="welcome-glow" aria-hidden>
        <i />
        <i />
      </div>
      {intro ? (
        <WelcomeIntro onDone={introDone} />
      ) : (
        <div className="welcome-body scroll">
          <div className="setup-card" key={step}>
            <div className="setup-steps" aria-hidden>
              {steps.map((name, i) => (
                <i
                  key={name}
                  className={cx(i === index && "on", i < index && "done")}
                />
              ))}
            </div>
            {step === "look" && <LookStep />}
            {step === "account" && <AccountStep onDone={next} last={last} />}
            {step === "import" && <ImportStep sources={offered(found)} />}
            <div className="setup-nav">
              {index > 0 ? (
                <button
                  className="btn ghost"
                  onClick={() => setIndex(index - 1)}
                >
                  <ArrowLeft size={15} />
                  {t("setup.back")}
                </button>
              ) : (
                <button className="btn ghost" onClick={finish}>
                  {t("setup.skip")}
                </button>
              )}
              {step === "import" && hostCount === 0 ? (
                <button className="btn" onClick={finish}>
                  {t("setup.import.skip")}
                </button>
              ) : (
                step !== "account" && (
                  <button className="btn primary" onClick={next}>
                    {last ? t("setup.done") : t("setup.next")}
                    <ChevronRight size={15} />
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      )}
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
            <div
              className="swatches"
              role="radiogroup"
              aria-label={t("settings.accent")}
            >
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
          <Setting
            name={t("settings.suggestions")}
            hint={t("setup.suggestions.hint")}
          >
            <Switch
              on={s.suggestions}
              onChange={(suggestions) => s.set({ suggestions })}
            />
          </Setting>
          <Setting
            name={t("settings.server_stats")}
            hint={t("setup.server_stats.hint")}
          >
            <Switch
              on={s.serverStats}
              onChange={(serverStats) => s.set({ serverStats })}
            />
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

function AccountStep(props: { onDone: () => void; last: boolean }) {
  const t = useT();
  const account = useVault((s) => s.snapshot.cloud);
  const plan = usePlan((s) => s.plan?.plan);
  const finish = props.onDone;
  return (
    <>
      <StepHead
        title={t("setup.account.title")}
        text={t("setup.account.text")}
      />
      <div className="setup-split account">
        <div className="setup-pro">
          <div className="setup-pro-title">
            {t("setup.pro.title")}
            <ProBadge />
          </div>
          <ProFeature
            icon={<Cloud size={16} />}
            title={t("setup.pro.sync")}
            text={t("setup.pro.sync.text")}
          />
          <ProFeature
            icon={<Users size={16} />}
            title={t("setup.pro.share")}
            text={t("setup.pro.share.text")}
          />
          <ProFeature
            icon={<WandSparkles size={16} />}
            title={t("setup.pro.ai")}
            text={t("setup.pro.ai.text")}
          />
          <p className="setup-free">{t("setup.free")}</p>
        </div>
        <div className="setup-sign">
          {account ? (
            <div className="setup-signed">
              <div className="name">
                {t("setup.signed_in", { email: account.email })}
              </div>
              {plan === "free" && (
                <>
                  <div className="hint">{t("setup.signed_in.free")}</div>
                  <GetProButton />
                </>
              )}
              <button className="btn primary setup-finish" onClick={finish}>
                {t(props.last ? "setup.done" : "setup.next")}
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

/**
 * Hosts other apps on this computer hold, offered to bring over: each
 * source opens the import as it is in the hosts' page, its new hosts
 * ticked. Shown only when there is something new to bring.
 */
function ImportStep(props: { sources: ImportSource[] }) {
  const t = useT();
  const hostCount = useVault((s) => s.snapshot.hosts.length);
  const [open, setOpen] = useState<ImportSource | null>(null);
  const total = props.sources.reduce((n, source) => n + source.hosts.filter((host) => !host.exists).length, 0);
  return (
    <>
      <StepHead title={t("setup.import.title")} text={t("setup.import.text", { n: total })} />
      <div className="setup-import">
        {hostCount > 0 && (
          <div className="setup-import-done">
            <Check size={16} />
            {t("setup.import.done", { hosts: t("hosts.count", { n: hostCount }) })}
          </div>
        )}
        <div className="import-sources">
          {props.sources.map((source) => (
            <button
              key={source.kind + source.location}
              type="button"
              className="import-source"
              onClick={() => setOpen(source)}
            >
              <span className="card-icon accent small">
                <Download size={15} />
              </span>
              <span className="import-main">
                <b>{t(`import.kind.${source.kind}`)}</b>
                <small>
                  {t("hosts.count", { n: source.hosts.filter((host) => !host.exists).length })} · {source.location}
                </small>
              </span>
              <ChevronRight size={15} className="dim" />
            </button>
          ))}
        </div>
        <p className="dim">{t("setup.import.hint")}</p>
      </div>
      {open && <ImportDialog initial={open} onClose={() => setOpen(null)} />}
    </>
  );
}
