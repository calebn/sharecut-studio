import { useState } from "react";

type Props = {
  message: string | null | undefined;
  /** For `aria-describedby` on the control the error belongs to. */
  id?: string;
  /** Render a `<span>` for use inside inline (phrasing) content. */
  inline?: boolean;
  /**
   * `"action"` (default): the result of what the person just did, announced
   * at once (`role="alert"`). `"state"`: an error kept in loaded or background
   * state (a job, a settings load) that outlives the panel showing it. It is
   * announced politely (`role="status"`) only when it appears while the line
   * is mounted, so switching back to a tab does not speak a saved error again.
   * Mount a `"state"` line unconditionally and let the message come and go.
   */
  origin?: "action" | "state";
};

/**
 * An error line. It renders nothing without a message, so mount it where the
 * error belongs and let the message come and go; see `origin` for how a new
 * error is announced.
 */
export function InlineError({
  message,
  id,
  inline = false,
  origin = "action",
}: Props) {
  // The state message this line mounted with is already known: show it quietly.
  // Any change (including clearing it) makes the next state message new.
  const [knownAtMount, setKnownAtMount] = useState(message ?? null);
  if (knownAtMount !== null && message !== knownAtMount) {
    setKnownAtMount(null);
  }
  if (!message) {
    return null;
  }
  const role =
    origin === "action"
      ? "alert"
      : message === knownAtMount
        ? undefined
        : "status";
  const className = "inline-error pipeline-error";
  return inline ? (
    <span key={role} id={id} role={role} className={className}>
      {message}
    </span>
  ) : (
    <p key={role} id={id} role={role} className={className}>
      {message}
    </p>
  );
}
