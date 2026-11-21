import { sendGuestPost } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { errorMessage } from "../../utils/apiError";
import { isLinkEnded } from "../../utils/linkEnded";
import {
  loadOutbox,
  loadReturnedPosts,
  type OutboxRow,
  removeOutbox,
  returnOutboxRow,
  serverIdOf,
  setOutboxSending,
  slotOf,
  waitingSlot,
} from "./outboxStore";

/** The host's longest comment or reply, in characters. */
const BODY_LIMIT = 8000;

const PARENT_NOT_POSTED = "The comment it answers was not posted.";

/** Why the host refused a post, in words for the person who wrote it. */
export function refusalReasonOf(
  row: Pick<OutboxRow, "kind" | "body">,
  status: number,
  error: unknown,
): string {
  if (status === 403) {
    return row.kind === "reply"
      ? "This link no longer allows replies."
      : "This link no longer allows comments.";
  }
  if (status === 413 || (status === 422 && row.body.length > BODY_LIMIT)) {
    return `It's longer than ${BODY_LIMIT.toLocaleString("en-US")} characters. Shorten it and send again.`;
  }
  return errorMessage(error);
}

async function withOutboxLock(
  token: string,
  run: () => Promise<void>,
): Promise<void> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return run();
  // Another tab holding the lock is already sending this link's rows.
  await locks.request(
    `sharecut-outbox:${token}`,
    { ifAvailable: true },
    async (lock) => {
      if (lock) await run();
    },
  );
}

/**
 * Sends the guest's kept comments and replies in the order they were written.
 * A host that does not answer ends the pass with every row still kept; a host
 * that refuses a row for good returns it to the guest and the pass goes on.
 * Never sends the same row twice: its id is the server's repeat key.
 */
export function drainOutbox(token: string): Promise<void> {
  return withOutboxLock(token, async () => {
    const rows = await loadOutbox(token);
    const unposted = new Set(
      (await loadReturnedPosts(token)).map((row) => waitingSlot(row.id)),
    );
    for (const row of rows) {
      if (isLinkEnded(token)) return;
      const parent = row.parent_comment_id;
      if (parent !== undefined && unposted.has(slotOf(parent))) {
        await returnOutboxRow(token, row.id, PARENT_NOT_POSTED, null);
        unposted.add(waitingSlot(row.id));
        continue;
      }
      const target =
        parent === undefined
          ? undefined
          : serverIdOf(parent, useDawStore.getState().project?.comments ?? []);
      if (parent !== undefined && target === null) continue;
      setOutboxSending(token, row.id, true);
      let outcome: Awaited<ReturnType<typeof sendGuestPost>>;
      try {
        outcome = await sendGuestPost(token, row, target ?? undefined);
      } finally {
        setOutboxSending(token, row.id, false);
      }
      if (outcome.status === "retry") return;
      if (outcome.status === "sent") {
        await removeOutbox(token, row.id);
        continue;
      }
      await returnOutboxRow(
        token,
        row.id,
        refusalReasonOf(row, outcome.code, outcome.error),
        outcome.code,
      );
      unposted.add(waitingSlot(row.id));
    }
  });
}
