import { History, SquareTerminal } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { findSpans } from "../../lib/highlight";
import { useT } from "../../lib/i18n";
import { highlightColors } from "../../lib/sessions";
import { cursorColorOf, fontStack, isDark, useSettings } from "../../lib/settings";
import { resolveTermTheme } from "../../lib/themes";
import { StatsLine, type StatsView } from "../terminal/StatsBar";
import { SuggestKeys } from "../terminal/SuggestKeys";

/** What advanced mode would say about the sample's server. */
const SAMPLE_STATS: StatsView = {
  cpu: 14,
  cores: 4,
  memUsed: 2.1 * 1024 ** 3,
  memTotal: 7.8 * 1024 ** 3,
  diskFree: 31 * 1024 ** 3,
  diskTotal: 78 * 1024 ** 3,
  uptime: 41 * 86400 + 3 * 3600,
  load: 0.08,
};

/** A stretch of text in one colour; `extra` is whatever stands right after it. */
type Piece = { text: string; colour?: string; bold?: boolean; back?: string; link?: boolean; extra?: ReactNode };

const piece = (text: string, colour?: string, bold?: boolean): Piece => ({ text, colour, bold });
/** What is being typed at the last prompt when suggestions are shown. */
const TYPED = "doc";

/**
 * A stretch of a terminal as it will look with the settings as they are:
 * the scheme's colours, the font, what gets highlighted, the cursor, and
 * what the switches beside it add: a link to click, a selection that is
 * copied, suggestions under what is typed. What a server would print in
 * colour is coloured here by hand; what it would print plain goes through
 * the very highlighter the terminal uses.
 */
export function TerminalSample() {
  const t = useT();
  const s = useSettings();
  const theme = resolveTermTheme(s.termTheme, isDark(s.theme)).colors;
  const rules = { ip: s.highlightIp, status: s.highlightStatus, urls: s.terminalLinks };
  const colours = highlightColors(s);
  const tip = (text: string) => <span className="sample-tip">{text}</span>;

  const prompt = (command: string): Piece[] => [
    piece("deploy@web-01", theme.green),
    piece(":"),
    piece("~/app", theme.blue),
    piece(`$ ${command}`),
  ];
  /** Plain output, with what the terminal would pick out in it. */
  const plain = (text: string): Piece[] => {
    const pieces: Piece[] = [];
    let at = 0;
    for (const span of findSpans(text, rules, colours).sort((a, b) => a.start - b.start)) {
      if (span.start < at) continue;
      if (span.start > at) pieces.push(piece(text.slice(at, span.start)));
      const found = text.slice(span.start, span.end);
      // A link is what a click with the key held opens; the sample says so beside it.
      const link = s.terminalLinks && /^https?:\/\//.test(found);
      pieces.push({ text: found, colour: span.color, link, extra: link ? tip(t("settings.sample.link")) : undefined });
      at = span.end;
    }
    if (at < text.length) pieces.push(piece(text.slice(at)));
    return pieces;
  };
  const lines: Piece[][] = [
    prompt("git status"),
    [piece("On branch "), piece("main", theme.magenta)],
    [
      piece("  modified:   ", theme.red),
      // Selected, and with "copy on select" already on the clipboard.
      s.copyOnSelect
        ? { text: "deploy.yml", back: theme.selectionBackground, extra: tip(t("settings.sample.copied")) }
        : piece("deploy.yml"),
    ],
    prompt("ls"),
    [
      piece("releases", theme.blue, true),
      piece("  "),
      piece("deploy.sh", theme.green, true),
      piece("  "),
      piece("current", theme.cyan, true),
    ],
    [piece("notes.md  "), piece("old.tar.gz", theme.red, true)],
    prompt("./deploy.sh"),
    plain("warning: 2 files changed"),
    plain("error: 10.0.0.12 refused, retrying"),
    plain("success: https://example.com"),
    [piece("# 0O 1lI {}[]() => != <= ~", theme.brightBlack)],
    prompt(s.suggestions ? TYPED : ""),
  ];
  const font = { fontFamily: fontStack(s.fontFamily), fontSize: s.fontSize };

  return (
    <div
      className="term-preview"
      aria-label={t("settings.preview")}
      style={{ background: theme.background, color: theme.foreground }}
    >
      <pre style={{ ...font, lineHeight: s.lineHeight }}>
        {lines.map((line, row) => (
          <Fragment key={row}>
            {line.map((part, index) => (
              <Fragment key={index}>
                <span
                  style={{
                    color: part.colour,
                    fontWeight: part.bold ? 700 : undefined,
                    background: part.back,
                    textDecoration: part.link ? "underline" : undefined,
                  }}
                >
                  {part.text}
                </span>
                {part.extra}
              </Fragment>
            ))}
            {row < lines.length - 1 ? "\n" : null}
          </Fragment>
        ))}
        <span
          className={`sample-cursor ${s.cursorStyle}${s.cursorBlink ? " blink" : ""}`}
          style={{ color: cursorColorOf(s.cursorColor, theme) }}
        >
          {" "}
        </span>
      </pre>
      {s.suggestions && (
        // Under what is being typed, as far in as the cursor when there is room.
        <div className="sample-suggest" style={font}>
          <div className="suggest">
            {(
              [
                ["docker ps", History],
                ["docker compose up -d", SquareTerminal],
                ["docker logs -f web", History],
              ] as const
            ).map(([command, Icon], index) => (
              <div key={command} className={index === 0 ? "suggest-item preview" : "suggest-item"}>
                <Icon size={13} className="suggest-icon" />
                <span className="suggest-text">
                  <mark className="suggest-typed">{command.slice(0, TYPED.length)}</mark>
                  {command.slice(TYPED.length)}
                </span>
              </div>
            ))}
            <SuggestKeys entered={false} />
          </div>
        </div>
      )}
      {s.serverStats && s.statsBar && <StatsLine stats={SAMPLE_STATS} />}
    </div>
  );
}
