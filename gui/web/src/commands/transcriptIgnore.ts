import { setTranscriptWordsIgnored } from "../api";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { ignoreTarget } from "../transcript/ignoredWords";
import { errorMessage } from "../utils/apiError";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

let ignoreInFlight = false;

/** Test-only: clear the in-flight guard between cases. */
export function _resetTranscriptIgnoreInFlightForTests(): void {
  ignoreInFlight = false;
}

/**
 * `transcript.ignoreWords` (#633): strike through and mute a word range at
 * render, non-destructively. Host-only — disabled for a share key and while
 * transcript words are unhydrated. A second call while one is in flight is
 * dropped, so a double click adds one undo step.
 */
export function registerTranscriptIgnoreCommands(): void {
  registerCommand(
    "transcript.ignoreWords",
    async (args): Promise<ExecuteResult> => {
      const s = useDawStore.getState();
      if (isShareProjectKey(s.projectPath)) {
        return { status: "disabled", reason: "Ignore is host-only" };
      }
      if (!s.project) {
        return { status: "disabled", reason: "No project loaded" };
      }
      if (s.project.meta.hydration?.transcript_words === false) {
        return { status: "disabled", reason: "Transcript words not loaded" };
      }
      const target = ignoreTarget(s.project, s.selection, {
        trackId: typeof args.trackId === "string" ? args.trackId : undefined,
        startWordIndex:
          typeof args.startWordIndex === "number"
            ? args.startWordIndex
            : undefined,
        endWordIndex:
          typeof args.endWordIndex === "number" ? args.endWordIndex : undefined,
        ignored: typeof args.ignored === "boolean" ? args.ignored : undefined,
      });
      if (!target) {
        return { status: "disabled", reason: "No transcript range selected" };
      }
      if (ignoreInFlight) {
        return { status: "disabled", reason: "Ignore already in progress" };
      }
      ignoreInFlight = true;
      try {
        await setTranscriptWordsIgnored(
          s.projectPath,
          target.trackId,
          target.startWordIndex,
          target.endWordIndex,
          target.ignored,
        );
        useDawStore
          .getState()
          .announceStatus(
            target.ignored ? "Ignored selection" : "Restored selection",
          );
        return { status: "ok" };
      } catch (e) {
        const msg = errorMessage(e);
        useDawStore.getState().announceStatus(`Ignore failed: ${msg}`);
        return { status: "disabled", reason: msg };
      } finally {
        ignoreInFlight = false;
      }
    },
  );
}
