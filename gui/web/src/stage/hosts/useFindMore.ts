import { useRef, useState } from "react";
import { startPipelineRun } from "../../api";
import { askConfirm } from "../../feedback/ask";
import { usePipelineWorkingSet } from "../../hooks/usePipelineWorkingSet";
import type { QueueJob } from "../../review/ReviewQueue";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { BUSY_REASON } from "../../ui/disabledReason";
import { errorMessage, isModelNeeded } from "../../utils/apiError";
import {
  isPipelineKindJob,
  isPipelineRunning,
  isPipelineSlotBusy,
} from "../../utils/pipeline";
import { pipelineProgressPercent } from "../../utils/pipelineProgress";
import { isTightenClass } from "../../utils/tightenHits";
import {
  currentTightenIntensity,
  findHitsConfirm,
  findHitsRunError,
  tightenProposeRunOptions,
} from "../../utils/tightenIntensity";

import { NO_TIER, useFindMoreFlow } from "./findMoreFlow";

/** Find more: reruns suggestion finding with the saved How tight, and reports the job. */
export function useFindMore(enabled: boolean) {
  const { project, projectPath, pipelineJob, activityJob, setPipelineJob } =
    useDaw((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      pipelineJob: s.pipelineJob,
      activityJob: s.activityJob,
      setPipelineJob: s.setPipelineJob,
    }));
  const { run, setRun, needs, stopFor, fresh } = useFindMoreFlow();
  const { cfg, loadError, fetchFresh } = usePipelineWorkingSet(
    projectPath,
    enabled,
  );
  const [starting, setStarting] = useState(false);
  const flying = useRef(false);

  const onFindMore = async () => {
    if (flying.current) return;
    flying.current = true;
    setStarting(true);
    const path = projectPath;
    const { projectEpoch: epoch } = useDawStore.getState();
    const current = () => {
      const s = useDawStore.getState();
      return s.projectPath === path && s.projectEpoch === epoch;
    };
    try {
      const hits = (project?.pending_edits ?? []).filter(
        (e) => !e.applied && isTightenClass(e.kind),
      ).length;
      const question = findHitsConfirm(hits);
      if (
        question &&
        !(await askConfirm({
          ...question,
          title: "Find more again?",
          message: `Finding more replaces the ${hits === 1 ? "1 undecided suggestion" : `${hits} undecided suggestions`} in this list, including ones you nudged.`,
          keepLabel: "Keep suggestions",
          actionLabel: "Find more",
        }))
      )
        return;
      setRun({ path, jobId: null, error: null });
      const fresh = current() ? await fetchFresh() : null;
      if (!fresh || !current()) return;
      const tier = currentTightenIntensity(fresh);
      if (!tier) throw new Error(NO_TIER);
      const started = await startPipelineRun(
        path,
        tightenProposeRunOptions(fresh, tier),
      );
      // The server holds the one pipeline slot now, so the store must show it
      // even when the host has moved to another project.
      setPipelineJob(started);
      if (!current()) return;
      setRun({ path, jobId: started.id, error: null });
      useDawStore.getState().announceStatus("Finding more suggestions…");
    } catch (e) {
      if (isModelNeeded(e) && current() && stopFor(e.model)) {
        return;
      }
      setRun({ path, jobId: null, error: errorMessage(e) });
      if (current())
        useDawStore
          .getState()
          .announceStatus("Could not find more suggestions.", {
            tone: "error",
          });
    } finally {
      flying.current = false;
      setStarting(false);
    }
  };

  const busy =
    isPipelineSlotBusy(activityJob) || isPipelineSlotBusy(pipelineJob);
  const mine = run?.path === projectPath ? run : null;
  const error =
    mine?.error ??
    findHitsRunError(
      mine?.jobId ?? null,
      pipelineJob,
      "Finding more suggestions failed.",
    );
  const running =
    isPipelineKindJob(pipelineJob) && isPipelineRunning(pipelineJob);
  const percent = pipelineProgressPercent(pipelineJob);
  const job: QueueJob | undefined = needs
    ? { title: "Finding more suggestions", needs }
    : error
      ? { title: "", error }
      : running
        ? {
            title:
              pipelineJob?.id === mine?.jobId
                ? "Finding more suggestions"
                : "Finding suggestions",
            progress: percent === null ? undefined : percent / 100,
          }
        : undefined;
  const disabledReason =
    starting || busy
      ? BUSY_REASON
      : cfg
        ? currentTightenIntensity(cfg)
          ? undefined
          : NO_TIER
        : loadError
          ? undefined // a press fetches the settings again
          : "Wait for the settings to load.";

  return {
    job,
    onFindMore: enabled
      ? () => {
          fresh();
          void onFindMore();
        }
      : undefined,
    findMoreDisabled: disabledReason,
  };
}
