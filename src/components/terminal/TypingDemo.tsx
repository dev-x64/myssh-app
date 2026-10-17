/**
 * Suggestions as they are used, for the terminal's tip: a few letters are
 * typed, the list opens, ↓ moves to the command wanted and Tab puts it on
 * the line. Five seconds, over and over; still when less motion is asked.
 */
export function TypingDemo() {
  return (
    <div className="tt-demo" aria-hidden="true">
      <div className="tt-line">
        <span className="tt-prompt">~$&nbsp;</span>
        <span className="tt-typed">doc</span>
        <span className="tt-rest">ker compose up -d</span>
        <span className="tt-cursor" />
      </div>
      <div className="tt-list">
        <div className="tt-item a1">docker ps</div>
        <div className="tt-item a2">docker compose up -d</div>
        <div className="tt-item">docker logs -f web</div>
      </div>
      <div className="tt-keys">
        <kbd className="tt-key k1">↓</kbd>
        <kbd className="tt-key k2">Tab</kbd>
      </div>
    </div>
  );
}
