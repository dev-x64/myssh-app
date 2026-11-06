import { Fragment } from "react";
import { useT, type MessageKey } from "../../lib/i18n";

/**
 * The keys of the suggestion list, under it: before it is gone into, how
 * to go into it and how to take the grey text; in it, how to move and what
 * Enter does there.
 */
export function SuggestKeys({ entered }: { entered: boolean }) {
  const t = useT();
  const parts: [string[], MessageKey][] = entered
    ? [
        [["↑", "↓"], "suggest.key.choose"],
        [["Enter"], "suggest.key.run"],
        [["Tab"], "suggest.key.insert"],
        [["Esc"], "suggest.key.hide"],
      ]
    : [
        [["↓"], "suggest.key.list"],
        [["Tab", "→"], "suggest.key.insert"],
        [["Esc"], "suggest.key.hide"],
      ];
  return (
    <div className="suggest-hint suggest-keys">
      {parts.map(([keys, label], index) => (
        <Fragment key={label}>
          {index > 0 && <span className="suggest-keys-gap" />}
          <span className="suggest-keys-part">
            {keys.map((key) => (
              <kbd key={key}>{key}</kbd>
            ))}
            {t(label)}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
