import { applyDuckingCommand, previewDucking } from "../api";
import { canEditMix, canManageProjects } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { ApiError, errorMessage } from "../utils/apiError";
import {
  DUCKING_CURRENT,
  duckingAppliedLine,
  duckingKind,
  duckingRefusal,
  duckingRefusalLine,
} from "./duckingCopy";
import { requestDuckingReplan } from "./duckingReplan";
import { registerCommand } from "./execute";
import { createSingleFlight } from "./singleFlight";
import type { ExecuteResult } from "./types";

const flight = createSingleFlight();

export function duckingBlocker(
  host: boolean,
  mixEditable: boolean,
): string | null {
  if (!host) return "Only the host can duck music";
  if (!mixEditable) return "Only the host and editors can change the mix";
  return null;
}

async function duck(args: Record<string, unknown>): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  const projectPath = s.projectPath;
  const blocker = duckingBlocker(
    canManageProjects(projectPath),
    canEditMix(projectPath, s.guestMode, s.shareCapabilities),
  );
  if (blocker) return { status: "disabled", reason: blocker };
  const run = await flight.run(async (): Promise<ExecuteResult> => {
    s.announceStatus("Lowering music under speech...");
    try {
      // The inspector passes the token of the plan it showed; the palette has
      // none, so it plans here and applies exactly that plan.
      let token = typeof args.planToken === "string" ? args.planToken : null;
      if (token === null) {
        const plan = await previewDucking(projectPath);
        if (duckingKind(plan) === "current") {
          useDawStore.getState().announceStatus(DUCKING_CURRENT);
          return { status: "ok" };
        }
        token = plan.planToken;
      }
      const outcome = await applyDuckingCommand(projectPath, token);
      const live = useDawStore.getState();
      if (outcome.queued) {
        live.announceStatus(
          "Studio is out of reach. Ducking is queued and will try to apply when it is back.",
        );
        return { status: "ok" };
      }
      if (!outcome.applied) {
        live.announceStatus(DUCKING_CURRENT);
        return { status: "ok" };
      }
      live.announceStatus(duckingAppliedLine(outcome), {
        undo: outcome.historyHead,
      });
      return { status: "ok" };
    } catch (e) {
      const refusal = duckingRefusal(e);
      // A refused plan is dead: show the person the fresh state, not the old row.
      if (e instanceof ApiError) requestDuckingReplan();
      const msg = refusal ? duckingRefusalLine(refusal) : errorMessage(e);
      useDawStore.getState().announceStatus(msg, { tone: "error" });
      return { status: "disabled", reason: msg, told: true };
    }
  }, "ducking");
  return run.ran
    ? run.value
    : { status: "disabled", reason: "Ducking is already running" };
}

/** Duck music under speech: a dry run to plan, then the apply with its token; one undo step. */
export function registerDuckingCommands(): void {
  registerCommand("track.duckUnderSpeech", duck);
}
