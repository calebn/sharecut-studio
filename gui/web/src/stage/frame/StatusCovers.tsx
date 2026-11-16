import { useEffect, useId, useRef, useState } from "react";
import { type GuestLoadFailure, guestLoadCover } from "../../guestLoadFailure";
import type { UnsentText } from "../../state/unsentText";
import { Cover } from "../../system/Cover";
import { HELD_BUSY_MS, useHeldBusy } from "../../system/useHeldBusy";
import type { NotServed } from "../../utils/notServed";

const COPIED_MS = 3_000;
const COPY_FAILED =
  "Couldn't copy. The text is selected, so you can copy it by hand.";

/** The words around what a guest typed and did not send, from its labels alone. */
function unsentWords(unsent: UnsentText[]): {
  heading: string;
  button: string;
  text: string;
} {
  const [only] = unsent;
  if (only && unsent.length === 1) {
    const label = only.label.toLowerCase();
    return {
      heading: `${only.label} was not posted`,
      button: `Copy ${label}`,
      text: only.text,
    };
  }
  return {
    heading: "These were not posted",
    button: "Copy all",
    text: unsent.map((one) => `${one.label}:\n${one.text}`).join("\n\n"),
  };
}

/** Characters a line of the box holds at the narrowest, for sizing the box in browsers without `field-sizing`. */
const CHARS_PER_LINE = 32;

/** Lines the text needs by its breaks and its length, clamped; the CSS cap bounds the box either way. */
function estimatedRows(text: string): number {
  const lines = text
    .split("\n")
    .reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)),
      0,
    );
  return Math.min(20, Math.max(2, lines));
}

/**
 * What a guest typed and did not send, handed back under the cover: a
 * read-only field holding the text, and the cover's own button to copy it.
 */
function useUnsentBlock(unsent: UnsentText[] | undefined) {
  const headingId = useId();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!unsent?.length) return null;
  const words = unsentWords(unsent);
  const copy = async () => {
    window.clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(words.text);
      setCopyStatus("Copied");
      // A second press may have set its timer while this one was waiting.
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopyStatus(""), COPIED_MS);
    } catch {
      const area = areaRef.current;
      area?.focus();
      area?.select();
      area?.setSelectionRange(0, words.text.length);
      setCopyStatus(COPY_FAILED);
    }
  };
  const block = (
    <div className="guest-unsent">
      <h2 id={headingId} className="guest-unsent-heading">
        {words.heading}
      </h2>
      <textarea
        ref={areaRef}
        className="guest-unsent-text"
        readOnly
        aria-labelledby={headingId}
        value={words.text}
        rows={estimatedRows(words.text)}
      />
    </div>
  );
  return { block, button: words.button, copy, copyStatus };
}

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
  unsent,
}: {
  failure: GuestLoadFailure;
  trying: boolean;
  onRetry: () => void;
  /** What the guest had typed and not sent when the link ended; with none the cover is unchanged. */
  unsent?: UnsentText[];
}) {
  const cover = guestLoadCover(failure);
  const mainRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const { busy, press } = useHeldBusy(trying, HELD_BUSY_MS);
  const [answered, setAnswered] = useState(false);
  const { title } = cover;
  const handBack = useUnsentBlock(unsent);

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
    <main
      ref={mainRef}
      className={`guest-page-cover${handBack ? " guest-page-cover--unsent" : ""}`}
    >
      <Cover
        size="page"
        glyph={cover.glyph}
        title={title}
        headingLevel="h1"
        titleRef={titleRef}
        extra={handBack?.block}
        primary={
          handBack
            ? { label: handBack.button, onClick: () => void handBack.copy() }
            : cover.button
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
        status={
          handBack ? handBack.copyStatus : cover.button ? status : undefined
        }
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
