import { cutSpeakers, joinNames } from "../edit/cutSpeech";
import { useDawStore } from "../state/dawStore";
import { errorMessage } from "../utils/apiError";
import {
  finishPendingReview,
  requireCurrentPendingReview,
} from "../utils/pendingReviewPass";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

type Choice = "cutAnyway" | "leaveGap";

/** Resubmit the refused ripple the way the person chose; the prompt stays open with the error on failure. */
async function choose(choice: Choice): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  const prompt = s.cutSpeechPrompt;
  if (!prompt || prompt.projectPath !== s.projectPath)
    return { status: "disabled", reason: "Nothing is waiting to be cut" };
  const run = choice === "cutAnyway" ? prompt.cutAnyway : prompt.leaveGap;
  if (!run)
    return { status: "disabled", reason: "This edit cannot leave a gap" };
  const names = joinNames(cutSpeakers(prompt.speech));
  try {
    if (prompt.kind === "pending-review") {
      requireCurrentPendingReview(prompt.review);
      s.setCutSpeechPrompt(null);
      const outcome = await prompt.cutAnyway();
      finishPendingReview(prompt.review, outcome);
      return { status: "ok" };
    }
    await run();
    const live = useDawStore.getState();
    if (live.cutSpeechPrompt === prompt) live.setCutSpeechPrompt(null);
    live.announceStatus(
      choice === "cutAnyway"
        ? `Cut, including ${names}'s speech. Undo restores it.`
        : `Left a gap. ${names}'s speech stays.`,
    );
    return { status: "ok" };
  } catch (error) {
    const reason = errorMessage(error);
    const live = useDawStore.getState();
    if (
      live.cutSpeechPrompt === prompt &&
      live.projectPath === prompt.projectPath
    )
      live.announceStatus(`Cut failed: ${reason}`);
    return { status: "disabled", reason };
  }
}

export function registerCutSpeechCommands(): void {
  registerCommand("edit.cutSpeech.cutAnyway", () => choose("cutAnyway"));
  registerCommand("edit.cutSpeech.leaveGap", () => choose("leaveGap"));
  registerCommand("edit.cutSpeech.cancel", () => {
    useDawStore.getState().setCutSpeechPrompt(null);
    return { status: "ok" };
  });
}
