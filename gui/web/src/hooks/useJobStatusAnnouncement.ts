import { useEffect, useMemo, useRef } from "react";
import { joinJobCopy } from "../state/jobCopy";
import type { JobChipObservation } from "../state/types";
import { useDaw } from "../state/useDaw";
import { modelNeededOfJob, notDownloadedLine } from "../utils/apiError";
import { isTerminalJobStatus } from "../utils/pipeline";
import { pipelineStateSentence } from "../utils/pipelineProgress";
import { plainError } from "../utils/plainError";

export function useJobStatusAnnouncement(): void {
  const {
    pipelineJob,
    activityJob,
    activityRunningCount,
    projectEpoch,
    jobResultStarts,
    jobFeedback,
    reconcileJobAnnouncements,
  } = useDaw((s) => ({
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    activityRunningCount: s.activityRunningCount,
    projectEpoch: s.projectEpoch,
    jobResultStarts: s.jobResultStarts,
    jobFeedback: s.jobFeedback,
    reconcileJobAnnouncements: s.reconcileJobAnnouncements,
  }));
  const chipJob = activityJob ?? pipelineJob;
  const jobId = chipJob?.id;
  const jobStatus = chipJob?.status;
  const chipModel = chipJob ? modelNeededOfJob(chipJob) : null;
  const modelFailed = chipModel !== null;
  const jobMessage = chipModel
    ? notDownloadedLine(chipModel)
    : chipJob?.message || chipJob?.label;
  const jobKind = chipJob?.kind;
  const chipTerminal = jobStatus != null && isTerminalJobStatus(jobStatus);

  const observation = useMemo<JobChipObservation | null>(() => {
    if (!jobStatus) return null;
    const detail =
      jobStatus === "error"
        ? jobMessage && (modelFailed ? jobMessage : plainError(jobMessage))
        : jobStatus === "cancelled"
          ? ""
          : jobMessage;
    return {
      id: jobId,
      kind: jobKind,
      status: jobStatus,
      copy: joinJobCopy([
        pipelineStateSentence({ kind: jobKind, status: jobStatus }),
        detail,
        activityRunningCount > 1 && `${activityRunningCount} activities`,
      ]),
    };
  }, [
    jobId,
    jobKind,
    jobStatus,
    jobMessage,
    modelFailed,
    activityRunningCount,
  ]);
  const observed = useRef<{
    epoch: number;
    observation: JobChipObservation | null;
  } | null>(null);

  useEffect(() => {
    const fresh =
      observed.current?.epoch !== projectEpoch ||
      observed.current.observation !== observation;
    observed.current = { epoch: projectEpoch, observation };
    reconcileJobAnnouncements(fresh ? observation : null, jobId, chipTerminal);
  }, [
    projectEpoch,
    observation,
    jobId,
    chipTerminal,
    jobResultStarts,
    jobFeedback,
    reconcileJobAnnouncements,
  ]);
}
