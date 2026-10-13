import { Button } from "../ui/Button";

export type LoadFailure = { message: string; onRetry: () => void };

/**
 * The first load of the transcript and history failed. It lives in the shell's
 * banner row: the touch shells are fixed to the viewport and would cover a
 * banner placed above them.
 */
export function LoadFailureBanner({
  failure,
}: {
  failure: LoadFailure | null | undefined;
}) {
  if (!failure) return null;
  return (
    <div className="guest-banner" role="alert">
      Could not load transcript and history. {failure.message}{" "}
      <Button variant="link" onClick={failure.onRetry}>
        Retry
      </Button>
    </div>
  );
}
