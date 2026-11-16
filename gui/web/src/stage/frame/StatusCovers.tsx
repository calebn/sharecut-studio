import { useEffect, useRef, useState } from "react";
import { type GuestLoadFailure, guestLoadCover } from "../../guestLoadFailure";
import { Cover } from "../../system/Cover";
import { HELD_BUSY_MS, useHeldBusy } from "../../system/useHeldBusy";
import type { NotServed } from "../../utils/notServed";

/**
 * A review link that did not open: the page's one `<main>` and its Cover.
 * A press on the button is answered on that button ("Trying…") and in a status
 * line, and the button keeps focus through a failure. The title is the page's
 * `h1` and takes focus when it arrives or changes, unless focus is already in
 * the cover, so a screen reader announces the title and sentence. `trying` is
 * any attempt in flight; only a press is shown as busy, so the page's own
 * retry stays silent.
 */
export function GuestPageCover({
  failure,
  trying,
  onRetry,
}: {
  failure: GuestLoadFailure;
  trying: boolean;
  onRetry: () => void;
}) {
  const cover = guestLoadCover(failure);
  const mainRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const { busy, press } = useHeldBusy(trying, HELD_BUSY_MS);
  const [answered, setAnswered] = useState(false);
  const { title } = cover;

  // A button that already has focus keeps it: moving focus to the title would
  // take it from the person who just pressed.
  useEffect(() => {
    if (!mainRef.current?.contains(document.activeElement)) {
      titleRef.current?.focus();
    }
  }, [title]);

  // The status speaks only about the press it answers: an attempt nobody
  // pressed starting forgets it.
  if (answered && trying && !busy) {
    setAnswered(false);
  }
  const status = busy ? "Trying again…" : answered ? cover.stillFailing : "";
  return (
    <main ref={mainRef} className="guest-page-cover">
      <Cover
        size="page"
        glyph={cover.glyph}
        title={title}
        headingLevel="h1"
        titleRef={titleRef}
        primary={
          cover.button
            ? {
                label: cover.button,
                onClick: () => {
                  press();
                  setAnswered(true);
                  onRetry();
                },
                busy,
                busyLabel: "Trying…",
              }
            : undefined
        }
        status={cover.button ? status : undefined}
      >
        {cover.sentence}
      </Cover>
    </main>
  );
}

export function NotServedCover({
  notServed,
  onNavigate,
}: {
  notServed: NotServed;
  onNavigate: (href: string) => void;
}) {
  return (
    <Cover
      size="page"
      glyph="folder-open"
      title="This episode isn't open on this computer"
      primary={{
        label: `Open ${notServed.name}`,
        onClick: () => onNavigate(notServed.openHref),
      }}
      secondary={{
        label: "All projects",
        onClick: () => onNavigate(notServed.homeHref),
      }}
    >
      {`This computer is open on ${notServed.name}.`}
    </Cover>
  );
}
