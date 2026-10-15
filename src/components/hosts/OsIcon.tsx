import { Server } from "lucide-react";
import {
  siAlmalinux,
  siAlpinelinux,
  siApple,
  siArchlinux,
  siCentos,
  siDebian,
  siDeepin,
  siElementary,
  siFedora,
  siFreebsd,
  siGentoo,
  siKalilinux,
  siLinux,
  siLinuxmint,
  siManjaro,
  siNetbsd,
  siNixos,
  siOpenbsd,
  siOpensuse,
  siOpenwrt,
  siPopos,
  siProxmox,
  siRaspberrypi,
  siRedhat,
  siRockylinux,
  siSlackware,
  siSuse,
  siSynology,
  siTruenas,
  siUbuntu,
  siVoidlinux,
  siZorin,
  type SimpleIcon,
} from "simple-icons";
import type { HostOs } from "../../lib/api";

/** Logos by the `ID` a system reports in its os-release. */
const LOGOS: Record<string, SimpleIcon> = {
  ubuntu: siUbuntu,
  debian: siDebian,
  centos: siCentos,
  fedora: siFedora,
  rhel: siRedhat,
  rocky: siRockylinux,
  almalinux: siAlmalinux,
  arch: siArchlinux,
  archarm: siArchlinux,
  alpine: siAlpinelinux,
  opensuse: siOpensuse,
  "opensuse-leap": siOpensuse,
  "opensuse-tumbleweed": siOpensuse,
  sles: siSuse,
  suse: siSuse,
  kali: siKalilinux,
  linuxmint: siLinuxmint,
  raspbian: siRaspberrypi,
  gentoo: siGentoo,
  nixos: siNixos,
  manjaro: siManjaro,
  void: siVoidlinux,
  openwrt: siOpenwrt,
  pop: siPopos,
  zorin: siZorin,
  deepin: siDeepin,
  elementary: siElementary,
  slackware: siSlackware,
  proxmox: siProxmox,
  truenas: siTruenas,
  synology: siSynology,
  freebsd: siFreebsd,
  openbsd: siOpenbsd,
  netbsd: siNetbsd,
  macos: siApple,
  linux: siLinux,
};

/** Any other Linux gets the penguin rather than nothing. */
const BSD_LIKE = new Set(["freebsd", "openbsd", "netbsd", "macos", "sunos"]);

function logoFor(os: HostOs): SimpleIcon | null {
  return (
    LOGOS[os.id] ??
    (os.family ? LOGOS[os.family] : undefined) ??
    (BSD_LIKE.has(os.id) ? null : siLinux)
  );
}

/** A brand colour that would vanish on the card is replaced by the text colour. */
function visible(hex: string): string | undefined {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 0.2 || luminance > 0.92 ? undefined : `#${hex}`;
}

/** The server's operating system logo, or a generic server before it is known. */
export function OsIcon(props: { os: HostOs | null; size?: number }) {
  const size = props.size ?? 18;
  const logo = props.os ? logoFor(props.os) : null;
  if (!logo) return <Server size={size} />;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={props.os?.name}
      fill={visible(logo.hex) ?? "currentColor"}
    >
      <path d={logo.path} />
    </svg>
  );
}
