import { Button } from "../ui/Button";

export type LoadFailure = {
  message: string;
  onRetry: () => void;
  /** A warm reload is retrying while the episode stays open. */
  recovering?: boolean;
};

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
  if (failure.recovering) {
    return (
      <div className="guest-banner" role="status">
        Still loading transcript and history. {failure.message}
      </div>
    );
  }
  return (
    <div className="guest-banner" role="alert">
      Could not load transcript and history. {failure.message}{" "}
      <Button variant="link" onClick={failure.onRetry}>
        Retry
      </Button>
    </div>
  );
}
