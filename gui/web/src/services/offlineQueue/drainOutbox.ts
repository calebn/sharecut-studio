import { sendGuestPost } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { hostCauseNow } from "../../state/hostReach";
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
} from "../../state/outboxStore";
import { errorMessage } from "../../utils/apiError";
import { isLinkEnded } from "../../utils/linkEnded";

const BODY_LIMIT = 8000;

const PARENT_NOT_POSTED = "The comment it answers was not posted.";
const PARENT_GONE = "The comment it answers is gone.";

/** Passes in a row that found no comment for a reply once the project had loaded; two, so a project still catching up is not mistaken for a deleted comment. */
const PARENT_MISSES_BEFORE_RETURN = 2;
const parentMisses = new Map<string, number>();

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

const lockWaiting = new Set<string>();

async function withOutboxLock(
  token: string,
  run: () => Promise<void>,
): Promise<void> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return run();
  const name = `sharecut-outbox:${token}`;
  await locks.request(name, { ifAvailable: true }, async (lock) => {
    if (lock) {
      await run();
      return;
    }
    // Another tab is sending this link's rows and may have read the list before
    // ours was added: one more pass runs when it lets go.
    if (lockWaiting.has(token)) return;
    lockWaiting.add(token);
    void locks
      .request(name, async () => {
        lockWaiting.delete(token);
        await run();
      })
      .catch(() => lockWaiting.delete(token));
  });
}

export function drainOutbox(token: string): Promise<void> {
  return withOutboxLock(token, async () => {
    const queued = await loadOutbox(token);
    const unposted = new Set(
      (await loadReturnedPosts(token)).map((row) => waitingSlot(row.id)),
    );
    for (const { id } of queued) {
      if (isLinkEnded(token)) return;
      // Re-read each time: Don't send may have taken this row out since the pass began.
      const current = await loadOutbox(token);
      const row = current.find((item) => item.id === id);
      if (!row) continue;
      const parent = row.parent_comment_id;
      if (parent !== undefined && unposted.has(slotOf(parent))) {
        await returnOutboxRow(token, row.id, PARENT_NOT_POSTED, null);
        unposted.add(waitingSlot(row.id));
        continue;
      }
      const comments = useDawStore.getState().project?.comments;
      const target =
        parent === undefined ? undefined : serverIdOf(parent, comments ?? []);
      if (parent !== undefined && target === null) {
        const answersAWaitingComment = current.some(
          (item) =>
            item.kind === "comment" && waitingSlot(item.id) === slotOf(parent),
        );
        if (!comments || answersAWaitingComment) continue;
        const missKey = `${token}:${row.id}`;
        const misses = (parentMisses.get(missKey) ?? 0) + 1;
        if (misses < PARENT_MISSES_BEFORE_RETURN) {
          parentMisses.set(missKey, misses);
          continue;
        }
        parentMisses.delete(missKey);
        await returnOutboxRow(token, row.id, PARENT_GONE, null);
        unposted.add(waitingSlot(row.id));
        continue;
      }
      parentMisses.delete(`${token}:${row.id}`);
      // The host is known to be away: a real send would only hold "Sending…" up until it timed out.
      if (hostCauseNow(token) !== null) return;
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
