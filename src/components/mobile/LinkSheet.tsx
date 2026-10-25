// What a tap on a web address in a terminal offers on a phone.

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, ExternalLink } from "lucide-react";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useLinkOffer } from "../../lib/linkOffer";
import { useUi } from "../../lib/store";
import { Sheet } from "../ui";

export function LinkSheet() {
  const t = useT();
  const url = useLinkOffer((s) => s.url);
  if (!url) return null;
  const close = () => useLinkOffer.getState().offer(null);
  return (
    <Sheet title={t("mobile.link.title")} onClose={close}>
      <div className="m-link selectable">{url}</div>
      <div className="sheet-menu" role="menu">
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            void api.openLink(url).catch(() => {});
          }}
        >
          <ExternalLink size={20} />
          {t("mobile.link.open")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            void writeText(url).then(() => useUi.getState().toast("success", t("mobile.copied")), () => {});
          }}
        >
          <Copy size={20} />
          {t("mobile.link.copy")}
        </button>
      </div>
    </Sheet>
  );
}
