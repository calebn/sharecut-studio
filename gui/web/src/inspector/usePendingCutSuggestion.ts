import { useEffect, useMemo, useState } from "react";
import { loadPendingCutSuggestion } from "../api";
import {
  type PendingCutProposal,
  type PendingEditBaseline,
  pendingEditBaseline,
} from "../api/documentEdits";
import { useDawStore } from "../state/dawStore";
import { pickDaw, useDaw } from "../state/useDaw";
import type { PendingEditView, Selection } from "../types/project";
import { errorMessage } from "../utils/apiError";

type SuggestionCapture = Readonly<{
  projectPath: string;
  projectEpoch: number;
  editId: string;
  expected: PendingEditBaseline;
  selection: Selection;
  retryVersion: number;
}>;

type SuggestionState =
  | { kind: "ready"; capture: SuggestionCapture; proposal: PendingCutProposal }
  | { kind: "unavailable"; capture: SuggestionCapture; message: string };

const selectContext = pickDaw("projectPath", "projectEpoch", "selection");

function captureIsCurrent(capture: SuggestionCapture): boolean {
  const current = useDawStore.getState();
  const edit = current.project?.pending_edits.find(
    (item) => item.id === capture.editId,
  );
  return (
    current.projectPath === capture.projectPath &&
    current.projectEpoch === capture.projectEpoch &&
    current.selection === capture.selection &&
    edit?.applied === false &&
    edit.track_id === capture.expected.track_id &&
    edit.type === capture.expected.type &&
    (edit.timebase ?? "source") === capture.expected.timebase &&
    edit.source_start === capture.expected.start &&
    edit.source_end === capture.expected.end
  );
}

export function usePendingCutSuggestion(
  edit: PendingEditView,
  enabled: boolean,
) {
  const { projectPath, projectEpoch, selection } = useDaw(selectContext);
  const [retryVersion, setRetryVersion] = useState(0);
  const [state, setState] = useState<SuggestionState | null>(null);
  const identity = useMemo(
    () => ({
      id: edit.id,
      track_id: edit.track_id,
      type: edit.type,
      timebase: edit.timebase,
      source_start: edit.source_start,
      source_end: edit.source_end,
    }),
    [
      edit.id,
      edit.track_id,
      edit.type,
      edit.timebase,
      edit.source_start,
      edit.source_end,
    ],
  );

  const capture = useMemo<SuggestionCapture | null>(
    () =>
      enabled
        ? {
            projectPath,
            projectEpoch,
            selection,
            editId: identity.id,
            expected: pendingEditBaseline(identity),
            retryVersion,
          }
        : null,
    [enabled, identity, projectPath, projectEpoch, selection, retryVersion],
  );

  useEffect(() => {
    if (!capture) return;
    const controller = new AbortController();
    void loadPendingCutSuggestion(
      { projectPath: capture.projectPath, edit: identity },
      controller.signal,
    )
      .then((proposal) => {
        if (!controller.signal.aborted && captureIsCurrent(capture)) {
          setState({ kind: "ready", capture, proposal });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && captureIsCurrent(capture)) {
          setState({
            kind: "unavailable",
            capture,
            message: errorMessage(error),
          });
        }
      });
    return () => {
      controller.abort();
    };
  }, [capture, identity]);

  const currentState =
    state && state.capture === capture && captureIsCurrent(state.capture)
      ? state
      : null;

  return {
    state: currentState,
    retry: () => setRetryVersion((version) => version + 1),
    currentProposal: () =>
      currentState?.kind === "ready" && captureIsCurrent(currentState.capture)
        ? currentState.proposal
        : null,
  };
}
