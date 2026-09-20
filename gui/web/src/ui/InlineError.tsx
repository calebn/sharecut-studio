/** Non-pipeline error line (reuses `.pipeline-error` styling). */
export function InlineError({
  message,
}: {
  message: string | null | undefined;
}) {
  if (!message) {
    return null;
  }
  return <p className="inline-error pipeline-error">{message}</p>;
}
