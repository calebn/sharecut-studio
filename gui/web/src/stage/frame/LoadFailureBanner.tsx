import { Button } from "../../ui/Button";

export type LoadFailure = {
  message: string;
  onRetry: () => void;
  recovering?: boolean;
};

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
