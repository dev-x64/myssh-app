import { emailTypo } from "../../lib/emailTypos";
import { useT } from "../../lib/i18n";

/**
 * "Did you mean name@gmail.com?" under an e-mail field whose domain looks
 * like a slip. Shown once the field is left, not while it is being typed
 * in; one click puts the address right.
 */
export function EmailTypo(props: { email: string; typing: boolean; onUse: (email: string) => void }) {
  const t = useT();
  const meant = props.typing ? null : emailTypo(props.email);
  if (!meant) return null;
  return (
    <span className="hint email-typo" aria-live="polite">
      {t("email.typo")}{" "}
      <button type="button" className="link" onClick={() => props.onUse(meant)}>
        {meant}
      </button>
      ?
    </span>
  );
}
