import { useEffect } from "react";
import { Cover, type CoverProps } from "../system/Cover";

/**
 * Owns `<main>`; the Cover is its one section. `status` says how the last
 * save or recovery went, in a polite status line under the Cover's text.
 */
export function GuestCovers({
  cover,
  status,
  onOnline,
}: {
  cover: CoverProps;
  status?: string | null;
  /** Called once when the browser reports it is back online. Absent: no listener. */
  onOnline?: () => void;
}) {
  useEffect(() => {
    if (!onOnline) {
      return;
    }
    window.addEventListener("online", onOnline, { once: true });
    return () => window.removeEventListener("online", onOnline);
  }, [onOnline]);
  return (
    <main>
      <Cover
        {...cover}
        headingLevel="h1"
        extra={
          status ? (
            <p className="sys-cover-text" role="status">
              {status}
            </p>
          ) : undefined
        }
      />
    </main>
  );
}
