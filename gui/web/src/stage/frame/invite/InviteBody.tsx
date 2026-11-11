import { useEffect, useId, useRef } from "react";
import type { ShareOptions } from "../../../stages/deliver/shareLogic";
import { TunnelStatusLine } from "../../../stages/deliver/TunnelStatusLine";
import type { InviteGroup } from "../../../types/stage";
import { InlineError } from "../../../ui";
import { ListenLinkRow } from "./ListenLinkRow";
import { RecordLinks } from "./RecordLinks";
import { ReviewLinks } from "./ReviewLinks";

type Props = {
  options: ShareOptions;
  /** The group to bring into view and focus on open: the Record links, from the empty Person tile. */
  at?: InviteGroup | null;
};

type EndedFocus =
  | { group: "review" | "listen"; kind: "link"; token: string }
  | { group: "record"; kind: "room"; sessionId: string };

/**
 * The Invite sheet's rows: Review links, Record links, Listen link. Rows act as
 * they change; there is no Apply and no Create button, the link is made on its
 * first Copy.
 */
export function InviteBody({ options, at = null }: Props) {
  const { error, status, recovery, tunnel, blockedKey, rows } = options;
  const reviewId = useId();
  const recordId = useId();
  const listenId = useId();
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const recordHeading = useRef<HTMLHeadingElement>(null);
  const listenHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!at) return;
    const target = {
      review: reviewHeading,
      record: recordHeading,
      listen: listenHeading,
    }[at];
    // The dialog moves focus to its first control on the next frame; land after it.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        target.current?.focus({ preventScroll: true });
        target.current?.scrollIntoView?.({ block: "start" });
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [at]);

  // A copy the browser refused leaves the link selected, ready for Mod+C.
  useEffect(() => {
    if (!blockedKey) return;
    const text = document.querySelector<HTMLElement>(
      ".sys-link-text[data-selected]",
    );
    const selection = window.getSelection?.();
    if (text && selection) selection.selectAllChildren(text);
  }, [blockedKey, rows]);

  // Focus goes to the group heading once the ended link or room has left the
  // list: the list reloads after the stop, and a heading focused earlier would
  // be lost with it. An Undo brings the row back without moving focus.
  const ended = useRef<EndedFocus | null>(null);
  useEffect(() => {
    const gone = ended.current;
    if (!gone) return;
    const stillThere =
      gone.kind === "link"
        ? rows.some((row) => row.usable && row.token === gone.token)
        : rows.some((row) => row.usable && row.session_id === gone.sessionId);
    if (stillThere) return;
    ended.current = null;
    const heading = {
      review: reviewHeading,
      record: recordHeading,
      listen: listenHeading,
    }[gone.group];
    heading.current?.focus();
  }, [rows]);

  const headings = {
    review: reviewHeading,
    record: recordHeading,
    listen: listenHeading,
  };
  const stopLink = (group: "review" | "listen") => (token: string) => {
    const accepted = options.onStop(token, () => headings[group].current);
    if (accepted !== false) ended.current = { kind: "link", token, group };
  };
  const endRoom = (sessionId: string) => {
    const accepted = options.onEndRoom(
      sessionId,
      () => headings.record.current,
    );
    if (accepted !== false)
      ended.current = { kind: "room", sessionId, group: "record" };
  };
  return (
    <div className="inv-body">
      {tunnel ? <TunnelStatusLine status={tunnel} /> : null}
      <div className="inv-feedback" aria-live="polite">
        {recovery.kind === "needs_refresh" ? (
          <>
            <p role="alert" className="inv-note">
              {recovery.message}
            </p>
            {recovery.refreshError ? (
              <p className="inv-note">
                Refresh failed: {recovery.refreshError}
              </p>
            ) : null}
          </>
        ) : null}
        {error ? <InlineError message={error} /> : null}
        {!error && recovery.kind === "refreshing" ? (
          <p className="inv-note">Refreshing mix preview…</p>
        ) : null}
        {!error && recovery.kind === "retrying" ? (
          <p className="inv-note">Mix refreshed. Making the link…</p>
        ) : null}
        {status && !error && recovery.kind === "idle" ? (
          <p className="inv-note">{status}</p>
        ) : null}
      </div>
      <section className="inv-group" data-group="review">
        <h3
          ref={reviewHeading}
          id={reviewId}
          className="inv-heading"
          tabIndex={-1}
        >
          Review links
        </h3>
        <p className="inv-note">
          People who open a review link can comment, or edit if you let them.
          Links don't expire. Stop sharing turns one off, and Undo brings it
          back for a few seconds.
        </p>
        <ReviewLinks
          labelledBy={reviewId}
          options={options}
          onStop={stopLink("review")}
        />
      </section>
      <section className="inv-group" data-group="record">
        <h3
          ref={recordHeading}
          id={recordId}
          className="inv-heading"
          tabIndex={-1}
        >
          Record links
        </h3>
        <p className="inv-note">
          A guest link records the person who joins. A producer link lets your
          producer listen and comment without being recorded. Record links don't
          expire. End room turns them off, and Undo brings them back for a few
          seconds.
        </p>
        <RecordLinks
          labelledBy={recordId}
          options={options}
          onEndRoom={endRoom}
        />
      </section>
      <section className="inv-group" data-group="listen">
        <h3
          ref={listenHeading}
          id={listenId}
          className="inv-heading"
          tabIndex={-1}
        >
          Listen link
        </h3>
        <p className="inv-note">
          For the finished episode: listeners hear the version current when you
          first copy the link.
        </p>
        <ListenLinkRow options={options} onStop={stopLink("listen")} />
      </section>
    </div>
  );
}
