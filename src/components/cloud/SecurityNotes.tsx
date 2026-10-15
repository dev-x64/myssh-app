import { Cable, KeyRound, Lock, ShieldCheck } from "lucide-react";
import { useT, type MessageKey } from "../../lib/i18n";

const NOTES: { icon: typeof Lock; title: MessageKey; text: MessageKey }[] = [
  { icon: Lock, title: "security.e2e.title", text: "security.e2e.text" },
  { icon: KeyRound, title: "security.password.title", text: "security.password.text" },
  { icon: ShieldCheck, title: "security.local.title", text: "security.local.text" },
  { icon: Cable, title: "security.direct.title", text: "security.direct.text" },
];

/** How the user's data is protected, in four plain statements. */
export function SecurityNotes() {
  const t = useT();
  return (
    <section className="security" aria-label={t("security.title")}>
      <h2>{t("security.title")}</h2>
      {NOTES.map(({ icon: Icon, title, text }) => (
        <div key={title} className="security-item">
          <span className="security-icon">
            <Icon size={15} />
          </span>
          <div>
            <div className="security-name">{t(title)}</div>
            <div className="security-text">{t(text)}</div>
          </div>
        </div>
      ))}
      <p className="security-more">{t("security.more")}</p>
    </section>
  );
}
