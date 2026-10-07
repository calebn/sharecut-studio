import { addChapter } from "../api";
import { useDawStore } from "../state/dawStore";
import { errorMessage } from "../utils/apiError";
import { registerCommand } from "./execute";
import { hostProjectGate } from "./host";
import type { ExecuteResult } from "./types";

/**
 * `edit.addChapter`: the Menu › Markers item, MobileShell's More action and
 * the touch create menu (`{ atTime }`, the held time; else the playhead)
 * share this one implementation (previously OverlayLegend's own + Chapter
 * button). Single-flight via the store's `chapterAddPending` flag rather
 * than a module ref, so a menu unmounting/remounting the control mid-add
 * still sees it pending. Guarded by `projectEpoch`: a settled add whose
 * project has since changed (hydrate resets `chapterAddPending` and bumps
 * the epoch) must not select, announce, or clear the new project's flag.
 * Turns the Markers layer on so the new chapter is visible.
 */
export function registerChapterCommands(): void {
  registerCommand(
    "edit.addChapter",
    async (args, ctx): Promise<ExecuteResult> => {
      const blocked = hostProjectGate(ctx);
      if (blocked) {
        return blocked;
      }
      const store = useDawStore.getState();
      if (store.chapterAddPending) {
        return { status: "disabled", reason: "Add already in progress" };
      }
      store.setChapterAddPending(true);
      store.setLayerVisible("showMarkers", true);
      const {
        playheadSec: playhead,
        projectEpoch,
        projectPath,
      } = useDawStore.getState();
      const at = Number(args.atTime);
      const atSec = args.atTime != null && Number.isFinite(at) ? at : playhead;
      const title = `Chapter ${atSec.toFixed(1)}s`;
      const sameProject = () =>
        useDawStore.getState().projectEpoch === projectEpoch;
      useDawStore
        .getState()
        .announceStatus(`Adding chapter at ${atSec.toFixed(1)}s…`);
      try {
        await addChapter(projectPath, atSec, title);
        if (!sameProject()) {
          return { status: "ok" };
        }
        useDawStore.getState().setSelection({
          kind: "chapter",
          id: title,
          time: atSec,
        });
        useDawStore
          .getState()
          .announceStatus(`Chapter added at ${atSec.toFixed(1)}s`);
        return { status: "ok" };
      } catch (err) {
        const reason = errorMessage(err);
        if (sameProject()) {
          useDawStore
            .getState()
            .announceStatus(`Add chapter failed: ${reason}`);
        }
        return { status: "disabled", reason };
      } finally {
        if (sameProject()) {
          useDawStore.getState().setChapterAddPending(false);
        }
      }
    },
  );
}
