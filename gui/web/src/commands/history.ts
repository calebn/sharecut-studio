import { HISTORY_STALE_CODE, redoHistory, undoHistory } from "../api";
import { useDawStore } from "../state/dawStore";
import {
  editSavesInFlight,
  HOST_SEND_WAIT_MS,
  headLandedSince,
  savesLandedMark,
} from "../state/hostSendOrder";
import { type HistoryEntryId, parseHistoryEntryId } from "../types/project";
import { ApiError, errorMessage } from "../utils/apiError";
import { raceTimeout } from "../utils/raceTimeout";
import { execute, registerCommand } from "./execute";
import { flushPendingMix } from "./trackMix";
import type { ExecuteResult } from "./types";

const STALE_COPY = {
  undo: "Can't undo: the project changed since. Nothing was undone.",
  redo: "Can't redo: the project changed since. Nothing was redone.",
} as const;

/** The wait for this tab's edit saves ran out: running the move now would act on the edit before them. */
const STILL_SAVING_COPY = {
  undo: "Your last edit is still saving. Nothing was undone.",
  redo: "Your last edit is still saving. Nothing was redone.",
} as const;

const NO_HEAD = "Open a project first.";

/**
 * This tab's own undo/redo moves (Mod+Z, Mod+Shift+Z, the History tab, the
 * toast Undo, the phone two-finger tap). They run one at a time: a press made
 * while an earlier one is in flight waits for its reply and expects the head
 * that reply returned. The tab's own undo moved the head; that is not someone
 * else's change, so it must not make the next press stale.
 */
const moves: {
  /** The last queued move; settles with the head it left (null: none). */
  tail: {
    projectPath: string;
    landed: Promise<HistoryEntryId | null>;
  } | null;
  /** The tab's last own move that landed: where it started and ended. */
  last: {
    projectPath: string;
    from: HistoryEntryId;
    to: HistoryEntryId;
  } | null;
} = { tail: null, last: null };

/**
 * The latest head this tab knows: the one it shows, unless it still shows
 * where its own last move started because the reply arrived before the update.
 */
function knownHead(projectPath: string): HistoryEntryId | null {
  const shown = useDawStore.getState().project?.history.head_id ?? null;
  const last = moves.last;
  return last?.projectPath === projectPath && shown === last.from
    ? last.to
    : shown;
}

/**
 * Undo or redo, guarded by the history head the person saw. A toast passes its
 * own change (`expectedHeadId`); other callers send the head this tab knows,
 * read after flushing its pending mix edits, or, behind an earlier move of
 * this tab, the head that move landed on. A press also waits behind the edit
 * saves this tab had in flight when it was made, and expects the head the
 * latest of this tab's own commands left, so Undo reverts the edit the person
 * just made. If those saves are still out after `HOST_SEND_WAIT_MS` the press
 * runs nothing and says the edit is still saving, rather than reverting the
 * edit before it and letting the slow one land after. A peer edit that arrives while a press waits its turn is never
 * adopted: the server refuses (`history_stale`) instead of reverting an edit
 * the person had not seen.
 */
function moveHistory(
  action: "undo" | "redo",
  projectPath: string,
  args: Record<string, unknown>,
): Promise<ExecuteResult> {
  const explicit = parseHistoryEntryId(args.expectedHeadId);
  const ahead =
    moves.tail?.projectPath === projectPath ? moves.tail.landed : null;
  const knownAtPress = knownHead(projectPath);
  const landedAtPress = savesLandedMark(projectPath);
  const savesAhead = editSavesInFlight(projectPath);
  let settle: (landed: HistoryEntryId | null) => void = () => {};
  const tail = {
    projectPath,
    landed: new Promise<HistoryEntryId | null>((resolve) => {
      settle = resolve;
    }),
  };
  moves.tail = tail;

  const run = async (): Promise<ExecuteResult> => {
    let landed: HistoryEntryId | null = null;
    try {
      const aheadLanded = ahead ? await ahead : null;
      const saved = await raceTimeout(
        savesAhead.then(() => true),
        HOST_SEND_WAIT_MS,
        () => false,
      );
      if (!saved) {
        useDawStore.getState().announceStatus(STILL_SAVING_COPY[action]);
        return {
          status: "disabled",
          reason: STILL_SAVING_COPY[action],
          announced: true,
        };
      }
      await flushPendingMix();
      const expectedHeadId =
        explicit ??
        headLandedSince(projectPath, landedAtPress) ??
        (ahead ? (aheadLanded ?? knownAtPress) : knownHead(projectPath));
      if (expectedHeadId === null) {
        return { status: "disabled", reason: NO_HEAD };
      }
      try {
        landed = await (action === "undo" ? undoHistory : redoHistory)(
          projectPath,
          { expectedHeadId },
        );
      } catch (e) {
        if (e instanceof ApiError && e.code === HISTORY_STALE_CODE) {
          useDawStore.getState().announceStatus(STALE_COPY[action]);
          return {
            status: "disabled",
            reason: STALE_COPY[action],
            announced: true,
          };
        }
        throw e;
      }
      if (landed !== null) {
        moves.last = { projectPath, from: expectedHeadId, to: landed };
      }
      return { status: "ok" };
    } finally {
      if (moves.tail === tail) moves.tail = null;
      settle(landed);
    }
  };
  return run();
}

/** Tests only: forget queued and landed moves. */
export function _resetHistoryMovesForTests(): void {
  moves.tail = null;
  moves.last = null;
}

export function registerHistoryCommands(): void {
  registerCommand("history.undo", (args, ctx) =>
    moveHistory("undo", ctx.projectPath, args),
  );
  registerCommand("history.redo", (args, ctx) =>
    moveHistory("redo", ctx.projectPath, args),
  );
}

const HISTORY_LABEL = { undo: "Undo", redo: "Redo" } as const;

/**
 * Runs Undo or Redo from a control or gesture. A failure is announced
 * ("Undo failed: …"), never dropped. `dispatch` is `execute` (keyboard-style
 * gates) unless the caller passes the pointer bridge.
 */
export function runHistoryAction(
  action: keyof typeof HISTORY_LABEL,
  dispatch: (id: string) => Promise<ExecuteResult> = (id) => execute(id),
): void {
  const report = (reason: string) =>
    useDawStore
      .getState()
      .announceStatus(`${HISTORY_LABEL[action]} failed: ${reason}`);
  void dispatch(`history.${action}`)
    .then((result) => {
      if (result.status === "ok") return;
      if (result.status === "disabled") {
        if (!result.announced) report(result.reason);
        return;
      }
      report("unavailable");
    })
    .catch((error: unknown) => report(errorMessage(error)));
}
