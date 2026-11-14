import { useEffect, useRef } from "react";
import { Cover, type CoverProps } from "../system/Cover";

/**
 * Owns `<main>`; the Cover is its one section. `status` says how the last
 * save or recovery went, in a polite status line under the Cover's text.
 * Focus moves to the Cover's heading whenever its title changes, the first
 * one included, so a keyboard or screen reader user lands on the new message.
 */
export function GuestCovers({
  cover,
  status,
  onOnline,
  onlineMissed,
}: {
  cover: CoverProps;
  status?: string | null;
  /** Called once when the browser reports it is back online. Absent: no listener. */
  onOnline?: () => void;
  /** True when the browser came back online while the last attempt was still running. */
  onlineMissed?: () => boolean;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const { title } = cover;
  useEffect(() => {
    if (title) {
      titleRef.current?.focus();
    }
  }, [title]);
  useEffect(() => {
    if (!onOnline) {
      return;
    }
    if (navigator.onLine !== false && onlineMissed?.()) {
      onOnline();
      return;
    }
    window.addEventListener("online", onOnline, { once: true });
    return () => window.removeEventListener("online", onOnline);
  }, [onOnline, onlineMissed]);
  return (
    <main>
      <Cover
        {...cover}
        headingLevel="h1"
        titleRef={titleRef}
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
