import { useT } from "../../lib/i18n";
import type { HostView } from "../../lib/api";
import { looksTailscale, peerOf, useTailscale } from "../../lib/tailscale";
import { cx } from "../ui";

/** Tailscale's mark: nine dots, the middle row and the one under it lit. */
function Mark() {
  const lit = [3, 4, 5, 7];
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden>
      {Array.from({ length: 9 }, (_, i) => (
        <circle key={i} cx={4 + (i % 3) * 8} cy={4 + Math.floor(i / 3) * 8} r="2.6" opacity={lit.includes(i) ? 1 : 0.35} />
      ))}
    </svg>
  );
}

/**
 * On a host's tile, when it is a machine of a tailnet: Tailscale's mark,
 * with whether Tailscale on this computer sees it online, and "SSH" when
 * it runs Tailscale SSH.
 */
export function TailscaleBadge({ host }: { host: HostView }) {
  const t = useT();
  const peers = useTailscale((s) => s.peers);
  if (!looksTailscale(host)) return null;
  const peer = peerOf(host, peers);
  const state = !peer ? "unknown" : peer.online ? "online" : "offline";
  const title = [t(`tailscale.${state}`), peer?.ssh ? t("tailscale.ssh") : null].filter(Boolean).join("\n");
  return (
    <span className={cx("ts-badge", state)} title={title}>
      <Mark />
      {peer?.ssh && <b>SSH</b>}
      {peer && <i />}
    </span>
  );
}
