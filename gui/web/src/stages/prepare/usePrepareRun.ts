import { useEffect, useState, useSyncExternalStore } from "react";
import { type ModelView, modelActivity, useModels } from "../../models";
import { useDawStore } from "../../state/dawStore";
import type { ModelNeeded } from "../../utils/apiError";
import {
  type PrepareAction,
  PrepareExecution,
  type PrepareFrame,
  type PrepareRunInput,
} from "./prepareExecution";
import type { ModelAsk } from "./prepareMappers";
import type { ReadyRowId } from "./ReadyList";

const WHISPER = "whisper";
const WORD_ALIGNER = "word-aligner";
function whatIs(need: ModelNeeded): string {
  return need.id === WHISPER
    ? "the transcription model"
    : need.id === WORD_ALIGNER
      ? "word timing"
      : need.label.toLowerCase();
}

function modelAskOf(
  need: ModelNeeded,
  row: ModelView | null,
  busy: boolean,
): ModelAsk {
  const { working, downloading, failure } = modelActivity(row, busy);
  const size = need.size || row?.size || "";
  const what = whatIs(need);
  if (working) {
    const known =
      downloading && downloading.total
        ? downloading.bytes / downloading.total
        : undefined;
    return { phase: "downloading", size, what, progress: known };
  }
  if (failure) {
    return { phase: "failed", size, what, failure: failure.plain };
  }
  return { phase: "ask", size, what };
}

export function usePrepareRun(input: PrepareRunInput) {
  const models = useModels();
  const epoch = useDawStore((store) => store.projectEpoch);
  const [execution] = useState(() => new PrepareExecution());
  const snapshot = useSyncExternalStore(
    execution.subscribe,
    execution.getSnapshot,
    execution.getSnapshot,
  );
  const frame: PrepareFrame = { input, epoch, models };
  useEffect(() => execution.attach(), [execution]);
  useEffect(() => execution.observe(frame));
  const owned =
    snapshot.owner?.path === input.projectPath &&
    snapshot.owner.epoch === epoch;
  const need = owned ? snapshot.need : null;
  const row = need
    ? (models.models?.find((model) => model.id === need.id) ?? null)
    : null;
  const alignerRow =
    models.models?.find((model) => model.id === WORD_ALIGNER) ?? null;
  const alignerIn = alignerRow?.state.kind === "installed";
  const dispatch = (action: PrepareAction) => execution.dispatch(frame, action);
  return {
    starting: snapshot.starting,
    waiting: owned && snapshot.waiting,
    startError: owned ? snapshot.startError : null,
    model: need ? modelAskOf(need, row, models.busy) : null,
    keepFixes: owned ? snapshot.keepFixes : null,
    approximateTiming:
      alignerRow && !alignerIn
        ? {
            size: alignerRow.size,
            downloading:
              modelActivity(alignerRow, models.busy).working ||
              (owned && snapshot.wantRetime),
          }
        : null,
    run: (
      mode: Extract<PrepareAction, { kind: "run" }>["mode"],
      overwriteEdited = false,
      fromStep?: string,
      skipped?: ReadonlySet<ReadyRowId>,
    ) => dispatch({ kind: "run", mode, overwriteEdited, fromStep, skipped }),
    tryAgain: () => void dispatch({ kind: "try-again" }),
    retranscribe: () => void dispatch({ kind: "retranscribe" }),
    keepMyFixes: () => void dispatch({ kind: "keep" }),
    replaceFixes: () => void dispatch({ kind: "replace" }),
    getModel: () => void dispatch({ kind: "get-model" }),
    getAligner: () => void dispatch({ kind: "get-aligner" }),
    cancel: () => dispatch({ kind: "cancel" }),
  };
}
