// Small shared building blocks.

import { AlertTriangle, CheckCircle2, Eye, EyeOff, Info, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";
import { useBack } from "../lib/back";
import { useT } from "../lib/i18n";
import { MOBILE } from "../lib/platform";
import { useUi } from "../lib/store";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * A field for a password, with an eye to look at what is in it: a slip is
 * easier to see than to guess at, and nothing shows while typing otherwise.
 */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <div className="password-input">
      <input
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        {...props}
        className={cx("input", props.className)}
        type={shown ? "text" : "password"}
      />
      <button
        type="button"
        className="eye"
        // Tab goes from the field to the next field, not to the eye.
        tabIndex={-1}
        title={t(shown ? "password.hide" : "password.show")}
        aria-label={t(shown ? "password.hide" : "password.show")}
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
      >
        {shown ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

export function Field(props: {
  label: string;
  hint?: string;
  error?: string | null;
  optional?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="field">
      <label>
        {props.label}
        {props.optional && <span className="dim">· {t("common.optional")}</span>}
      </label>
      {props.children}
      {props.error ? (
        <span className="error">{props.error}</span>
      ) : (
        props.hint && <span className="hint">{props.hint}</span>
      )}
    </div>
  );
}

export function Switch(props: { on: boolean; onChange: (on: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      className={cx("switch", props.on && "on")}
      onClick={() => props.onChange(!props.on)}
    />
  );
}

export function Segmented<V extends string>(props: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (value: V) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === props.value}
          className={cx(option.value === props.value && "active")}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** How many tags are offered at once under the field. */
const TAG_OFFERS = 6;

/**
 * The tags already in use that the text typed may be: those that begin
 * with it first, then those that hold it, then those it is a slip of (its
 * letters in order, some left out: "spoty" for "spotify").
 */
function tagOffers(draft: string, known: string[], chosen: string[]): string[] {
  const needle = draft.trim().toLowerCase();
  if (!needle) return [];
  const taken = new Set(chosen.map((tag) => tag.toLowerCase()));
  const inOrder = (name: string) => {
    let at = 0;
    for (const char of name) if (char === needle[at]) at++;
    return at === needle.length;
  };
  const ranked: { tag: string; rank: number }[] = [];
  for (const tag of new Set(known)) {
    const name = tag.toLowerCase();
    if (taken.has(name) || name === needle) continue;
    const rank = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : needle.length >= 3 && inOrder(name) ? 2 : -1;
    if (rank >= 0) ranked.push({ tag, rank });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.tag.localeCompare(b.tag))
    .slice(0, TAG_OFFERS)
    .map(({ tag }) => tag);
}

export function TagInput(props: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  /** The tags in use elsewhere, offered as one is typed. */
  known?: string[];
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  /** The offer picked with the arrow keys, if any. */
  const [picked, setPicked] = useState(-1);
  /** Escape put the offers away, until the text changes. */
  const [dismissed, setDismissed] = useState(false);
  const listId = useId();

  const offers = tagOffers(draft, props.known ?? [], props.tags);
  const open = focused && !dismissed && offers.length > 0;

  const add = (text: string) => {
    setDraft("");
    setPicked(-1);
    const tag = text.trim().replace(/,$/, "").trim();
    if (!tag) return;
    if (props.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return;
    // A tag in use already is kept as it is written there.
    const known = props.known?.find((existing) => existing.toLowerCase() === tag.toLowerCase());
    props.onChange([...props.tags, known ?? tag]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = offers.length;
      setPicked(e.key === "ArrowDown" ? (picked + 1) % n : picked <= 0 ? n - 1 : picked - 1);
    } else if (open && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      add(offers[Math.max(0, picked)]);
    } else if (open && e.key === "Escape") {
      // Only the offers go away, not the panel around the field.
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
      setPicked(-1);
    } else if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(open && picked >= 0 ? offers[picked] : draft);
    } else if (e.key === "Backspace" && !draft && props.tags.length) {
      props.onChange(props.tags.slice(0, -1));
    }
  };

  return (
    <div className="tag-input">
      {props.tags.map((tag) => (
        <span key={tag} className="chip accent">
          {tag}
          <button
            type="button"
            aria-label={`remove ${tag}`}
            onClick={() => props.onChange(props.tags.filter((other) => other !== tag))}
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={props.tags.length ? "" : props.placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          setPicked(-1);
          setDismissed(false);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          add(draft);
        }}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && picked >= 0 ? `${listId}-${picked}` : undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      {open && (
        <ul className="tag-offers" id={listId} role="listbox">
          {offers.map((tag, i) => (
            <li
              key={tag}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === picked}
              className={cx(i === picked && "active")}
              // Taken before the field loses its focus, which would add the text typed instead.
              onMouseDown={(e) => {
                e.preventDefault();
                add(tag);
              }}
              onMouseEnter={() => setPicked(i)}
            >
              {tag}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A dialog. `scope="tab"` covers only its positioned parent (a terminal
 * pane); the default covers the whole window.
 */
function ModalClose({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <button type="button" className="btn ghost icon small modal-close" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}>
      <X size={15} />
    </button>
  );
}

export function Modal(props: {
  title: string;
  icon?: ReactNode;
  danger?: boolean;
  wide?: boolean;
  scope?: "window" | "tab";
  onClose: () => void;
  onSubmit?: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLFormElement>(null);
  useBack(props.onClose);

  // Focus the first field, or the dialog itself so Escape works. On a
  // phone a field focused by itself brings up the keyboard over the
  // dialog before it has been read, so there only the dialog is.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const target = (!MOBILE && root.querySelector<HTMLElement>("[data-autofocus]")) || root;
    target.focus({ preventScroll: true });
  }, []);

  const dialog = (
    <div
      className={cx("overlay", props.scope !== "tab" && "global")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <form
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        className={cx("modal", props.danger && "danger", props.wide && "wide")}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit?.();
        }}
      >
        <div className="modal-head">
          {props.icon && <span className="badge">{props.icon}</span>}
          <h2>{props.title}</h2>
          {/* Escape and a click beside do the same; this says it can be done. */}
          <ModalClose onClose={props.onClose} />
        </div>
        <div className="modal-body scroll">{props.children}</div>
        <div className="modal-foot">{props.footer}</div>
      </form>
    </div>
  );
  // On a phone the bars hold their own layers; a dialog from one goes over everything.
  return MOBILE && props.scope !== "tab" ? createPortal(dialog, document.body) : dialog;
}

export function Confirm(props: {
  title: string;
  text: string;
  confirmLabel: string;
  danger?: boolean;
  scope?: "window" | "tab";
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Modal
      title={props.title}
      scope={props.scope}
      danger={props.danger}
      icon={props.danger ? <AlertTriangle size={17} /> : <Info size={17} />}
      onClose={props.onClose}
      onSubmit={props.onConfirm}
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className={cx("btn", props.danger ? "danger" : "primary")} data-autofocus>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <p>{props.text}</p>
    </Modal>
  );
}

export interface MenuEntry {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  x: number;
  y: number;
  entries: MenuEntry[];
  /** What the menu is about, said above it where it is a sheet. */
  title?: string;
  onClose: () => void;
}

/**
 * A context menu at a screen position, kept inside the window. On a phone,
 * where it opens with a long press, it is a sheet at the bottom instead,
 * its rows a finger's height.
 */
export function ContextMenu(props: MenuProps) {
  return MOBILE ? <MenuSheet {...props} /> : <PopupMenu {...props} />;
}

function MenuSheet(props: MenuProps) {
  return (
    <Sheet title={props.title} onClose={props.onClose}>
      <div className="sheet-menu" role="menu">
        {props.entries.map((entry) => (
          <div key={entry.label}>
            {entry.separatorBefore && <hr />}
            <button
              type="button"
              role="menuitem"
              className={cx(entry.danger && "danger")}
              onClick={() => {
                props.onClose();
                entry.onSelect();
              }}
            >
              {entry.icon}
              {entry.label}
            </button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * A panel that comes up from the bottom of a phone's screen, over a dimmed
 * window: a tap beside it, a swipe down or Back puts it away.
 */
export function Sheet(props: { title?: string; className?: string; onClose: () => void; children: ReactNode }) {
  useBack(props.onClose);
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  // Swiped down by its grip or title, it follows the finger and goes past a little way.
  const onTouchStart = (e: ReactTouchEvent) => {
    drag.current = { y: e.touches[0].clientY, dy: 0 };
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    if (!drag.current || !panel.current) return;
    drag.current.dy = Math.max(0, e.touches[0].clientY - drag.current.y);
    panel.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const onTouchEnd = () => {
    const moved = drag.current?.dy ?? 0;
    drag.current = null;
    if (moved > 80) props.onClose();
    else if (panel.current) panel.current.style.transform = "";
  };
  return createPortal(
    <div
      className="sheet-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div ref={panel} className={cx("sheet", props.className)} role="dialog" aria-label={props.title}>
        <div className="sheet-grab" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
          <span className="sheet-grip" />
          {props.title && <div className="sheet-title">{props.title}</div>}
        </div>
        <div className="sheet-body scroll">{props.children}</div>
      </div>
    </div>,
    document.body,
  );
}

function PopupMenu(props: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: props.x, top: props.y });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(props.x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(props.y, window.innerHeight - height - 8)),
    });
  }, [props.x, props.y]);

  useEffect(() => {
    const close = () => props.onClose();
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && props.onClose();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [props]);

  return (
    <div ref={ref} className="menu" role="menu" style={position}>
      {props.entries.map((entry) => (
        <div key={entry.label}>
          {entry.separatorBefore && <hr />}
          <button
            type="button"
            role="menuitem"
            className={cx(entry.danger && "danger")}
            onClick={() => {
              props.onClose();
              entry.onSelect();
            }}
          >
            {entry.icon}
            {entry.label}
          </button>
        </div>
      ))}
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={cx("toast", toast.kind)} onClick={() => dismiss(toast.id)}>
          {toast.kind === "error" ? (
            <AlertTriangle size={16} />
          ) : toast.kind === "success" ? (
            <CheckCircle2 size={16} />
          ) : (
            <Info size={16} />
          )}
          <div>
            <div>{toast.text}</div>
            {toast.detail && <div className="detail selectable">{toast.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Empty(props: { icon: ReactNode; title?: string; text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="glyph">{props.icon}</div>
      {props.title && <h2>{props.title}</h2>}
      <p>{props.text}</p>
      {props.action}
    </div>
  );
}
