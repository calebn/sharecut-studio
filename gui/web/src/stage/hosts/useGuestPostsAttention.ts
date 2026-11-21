import { useMemo } from "react";
import { dispatchComposer } from "../../commands/composer";
import { commentAnchorLabel } from "../../comments/commentAnchor";
import { useOutbox } from "../../comments/useOutbox";
import { copyText } from "../../record";
import type { GuestPostsAttention } from "../../review/reviewQueueModel";
import { shareTokenFromKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { type OutboxRow, removeReturned } from "../../state/outboxStore";

function whatOf(row: OutboxRow): string {
  const anchor = row.anchor;
  return row.kind === "reply" || !anchor
    ? "Your reply"
    : `Your comment at ${commentAnchorLabel({
        startSec: anchor.timeline_start,
        endSec: anchor.timeline_end,
      })}`;
}

/**
 * A guest's kept comments and replies for the Needs attention group: how many
 * wait, and the ones the host refused with their words handed back.
 */
export function useGuestPostsAttention(
  projectPath: string,
): GuestPostsAttention | undefined {
  const token = shareTokenFromKey(projectPath);
  const view = useOutbox(token);
  const composerEmpty = useDawStore(
    (s) => (s.composer.draft?.text ?? "") === "",
  );
  return useMemo(() => {
    if (!token) return undefined;
    const say = (message: string, tone?: "error") =>
      useDawStore.getState().announceStatus(message, tone ? { tone } : {});
    const returnedRow = (id: string) => view.returned.find((r) => r.id === id);
    return {
      waiting: {
        comments: view.rows.filter((r) => r.kind === "comment").length,
        replies: view.rows.filter((r) => r.kind === "reply").length,
      },
      returned: view.returned.map((row) => ({
        id: row.id,
        what: whatOf(row),
        reason: row.reason,
        text: row.body,
        canPutBack: row.kind === "comment",
      })),
      onCopy: (id) => {
        const row = returnedRow(id);
        if (!row) return;
        copyText(row.body).then(
          () => say(`Copied ${whatOf(row).toLowerCase()}`),
          () => say("Couldn't copy. Select the text and copy it.", "error"),
        );
      },
      onDismiss: (id) => {
        void removeReturned(token, id);
      },
      onPutBack: composerEmpty
        ? (id) => {
            const row = returnedRow(id);
            const anchor = row?.anchor;
            if (!row || !anchor) return;
            dispatchComposer({
              type: "type",
              text: row.body,
              composing: false,
              undo: false,
              fresh: {
                startSec: anchor.timeline_start,
                endSec: anchor.timeline_end,
                trackIds: anchor.track_ids,
                ...(anchor.timeline_spans
                  ? { intervals: anchor.timeline_spans }
                  : {}),
              },
            });
            void removeReturned(token, id);
          }
        : undefined,
    };
  }, [token, view, composerEmpty]);
}
