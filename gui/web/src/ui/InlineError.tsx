type Props = {
  message: string | null | undefined;
  /** For `aria-describedby` on the control the error belongs to. */
  id?: string;
  /** Render a `<span>` for use inside inline (phrasing) content. */
  inline?: boolean;
};

/**
 * An error line that is announced as soon as it appears (`role="alert"`). It
 * renders nothing without a message, so mount it where the error belongs and
 * let the message come and go; the alert speaks each new error once.
 */
export function InlineError({ message, id, inline = false }: Props) {
  if (!message) {
    return null;
  }
  const className = "inline-error pipeline-error";
  return inline ? (
    <span id={id} role="alert" className={className}>
      {message}
    </span>
  ) : (
    <p id={id} role="alert" className={className}>
      {message}
    </p>
  );
}
