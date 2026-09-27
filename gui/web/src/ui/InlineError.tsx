type Props = {
  message: string | null | undefined;
  /** For `aria-describedby` on the control the error belongs to. */
  id?: string;
  role?: "alert" | "status";
  /** Render a `<span>` for use inside inline (phrasing) content. */
  inline?: boolean;
};

/** Non-pipeline error line (reuses `.pipeline-error` styling). */
export function InlineError({ message, id, role, inline = false }: Props) {
  if (!message) {
    return null;
  }
  const className = "inline-error pipeline-error";
  return inline ? (
    <span id={id} role={role} className={className}>
      {message}
    </span>
  ) : (
    <p id={id} role={role} className={className}>
      {message}
    </p>
  );
}
