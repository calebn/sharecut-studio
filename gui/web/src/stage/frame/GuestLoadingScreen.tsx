import { Skeleton } from "../../system/Skeleton";

/**
 * A guest's first load: the skeleton of the guest frame, not a text screen.
 * Nothing draws for 300 ms; "Still loading…" with Retry shows at 4 s. The
 * status line is for assistive technology only.
 */
export function GuestLoadingScreen({
  label = "Loading project…",
  onRetry,
}: {
  label?: string;
  onRetry?: () => void;
}) {
  return (
    <main className="guest-loading" aria-busy="true">
      <p role="status" className="sr-only">
        {label}
      </p>
      <Skeleton layout="guest" onRetry={onRetry} />
    </main>
  );
}
