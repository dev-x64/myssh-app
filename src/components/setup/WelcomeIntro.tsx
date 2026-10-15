import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { cx } from "../ui";

/** The stage the intro is drawn on; it scales down to fit a small window. */
const W = 720;
const H = 420;
/** Where the mark sits, and where every connection starts. */
const CX = 360;
const CY = 168;

/** Servers around the mark, each connected to in turn. */
const NODES = [
  { x: 96, y: 66, name: "web-1" },
  { x: 58, y: 214, name: "db-main" },
  { x: 150, y: 340, name: "cache" },
  { x: 624, y: 58, name: "api" },
  { x: 664, y: 206, name: "build" },
  { x: 570, y: 344, name: "backup" },
];

/** When the greeting starts typing, and how fast. */
const TYPE_AT_MS = 820;
const CHAR_MS = 42;
/** When the intro leaves by itself, and how long leaving takes. */
const LEAVE_AT_MS = 3300;
const LEAVING_MS = 520;

/**
 * The first launch opens with a short greeting: the mark draws itself,
 * says hello as a terminal would type it, and connects to a few servers
 * around it; then it steps aside for the setup. A click or any key skips
 * it, and with reduced motion asked for it is not shown at all.
 */
export function WelcomeIntro({ onDone }: { onDone: () => void }) {
  const t = useT();
  const hello = t("intro.hello");
  const [typed, setTyped] = useState(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let timer = window.setTimeout(function tick() {
      setTyped((n) => {
        if (n + 1 < hello.length) timer = window.setTimeout(tick, CHAR_MS);
        return n + 1;
      });
    }, TYPE_AT_MS);
    const leave = window.setTimeout(() => setLeaving(true), LEAVE_AT_MS);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(leave);
    };
  }, [hello]);

  useEffect(() => {
    const skip = () => setLeaving(true);
    window.addEventListener("keydown", skip);
    return () => window.removeEventListener("keydown", skip);
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onDone, LEAVING_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onDone]);

  return (
    <div className={cx("intro", leaving && "leaving")} onClick={() => setLeaving(true)} aria-hidden>
      <div className="intro-stage" style={{ aspectRatio: `${W} / ${H}` }}>
        <svg className="intro-net" viewBox={`0 0 ${W} ${H}`}>
          {NODES.map((node, i) => (
            <line
              key={node.name}
              className="intro-line"
              x1={CX}
              y1={CY}
              x2={node.x}
              y2={node.y}
              pathLength={1}
              style={{ animationDelay: `${1.05 + i * 0.13}s` }}
            />
          ))}
        </svg>
        {NODES.map((node, i) => (
          <i
            key={`packet-${node.name}`}
            className="intro-packet"
            style={{
              offsetPath: `path("M ${CX} ${CY} L ${node.x} ${node.y}")`,
              animationDelay: `${1.25 + i * 0.13}s`,
            }}
          />
        ))}
        {NODES.map((node, i) => (
          <span
            key={node.name}
            className="intro-node"
            style={{
              left: `${(node.x / W) * 100}%`,
              top: `${(node.y / H) * 100}%`,
              animationDelay: `${0.95 + i * 0.13}s`,
            }}
          >
            <b style={{ animationDelay: `${1.7 + i * 0.13}s` }} />
            {node.name}
          </span>
        ))}

        <div className="intro-mark" style={{ left: `${(CX / W) * 100}%`, top: `${(CY / H) * 100}%` }}>
          <i className="intro-ring" />
          <i className="intro-ring late" />
          <svg viewBox="0 0 64 64">
            <defs>
              <linearGradient id="intro-face" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="var(--bg-4)" />
                <stop offset="1" stopColor="var(--bg-2)" />
              </linearGradient>
            </defs>
            <rect width="64" height="64" rx="15" fill="url(#intro-face)" />
            <rect x="0.5" y="0.5" width="63" height="63" rx="14.5" fill="none" stroke="var(--line-strong)" />
            <path
              className="intro-chevron"
              d="M18 23 L30 32 L18 41"
              pathLength={1}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <rect className="intro-cursor" x="34" y="38.5" width="14" height="5" rx="2.5" fill="var(--text)" />
          </svg>
        </div>

        <div className="intro-words" style={{ top: `${((CY + 78) / H) * 100}%` }}>
          <div className="intro-hello">
            {hello.slice(0, typed)}
            <span className="intro-caret" />
          </div>
          <div className="intro-tagline">{t("intro.tagline")}</div>
        </div>
      </div>
      <div className="intro-skip">{t("intro.skip")}</div>
    </div>
  );
}

/** Whether the intro is to be shown: not when the system asks for less motion. */
export function introWanted(): boolean {
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
