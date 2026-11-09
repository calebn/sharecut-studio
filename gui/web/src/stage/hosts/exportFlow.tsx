import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  cancelPipelineRun,
  type ExportEvidence,
  type ExportFormats,
  isHostProjectKey,
  JobCancelledError,
  loadPipelineConfig,
  readExportSettings,
  startExportJob,
} from "../../api";
import { useModelResume } from "../../models";
import type {
  ExportRequest,
  ExportSettingsStatus,
} from "../../stages/deliver/deliverLogic";
import { useDawStore } from "../../state/dawStore";
import { runAnnouncedJob } from "../../state/runAnnouncedJob";
import type { LoudnessId } from "../../types/pipeline";
import {
  errorMessage,
  isAbortError,
  isModelNeeded,
  type ModelNeeded,
  notDownloadedLine,
} from "../../utils/apiError";
import { editHeadOf } from "./deliverModel";
import { type ExportFlow, type ExportRun, Flow } from "./exportFlowContext";
import {
  type ExportReceipt,
  readExportReceipt,
  receiptCopy,
} from "./exportReceipt";
import {
  type ExportSettings,
  exportSettingsFromConfig,
  hasUnavailableFormats,
  resolveExport,
  sameExportFormats,
  selectedFormats,
} from "./exportSettings";

type Controls = Readonly<{
  formats:
    | { kind: "configured" }
    | { kind: "operator"; keys: readonly string[] };
  target: LoudnessId | null;
  inputOwner: symbol;
}>;

type ControlEvent =
  | { kind: "formats"; keys: readonly string[] }
  | { kind: "target"; target: LoudnessId | null }
  | { kind: "admitted"; target: LoudnessId | null; inputOwner: symbol }
  | { kind: "reset" };

function initialControls(): Controls {
  return {
    formats: { kind: "configured" },
    target: null,
    inputOwner: Symbol(),
  };
}

type Submission = Readonly<{
  projectPath: string;
  projectEpoch: number;
  formats: ExportFormats;
  target: LoudnessId | null;
  request: ExportRequest;
  inputOwner: symbol;
}>;

type OwnedRun =
  | Exclude<ExportRun, { kind: "done" }>
  | {
      kind: "done";
      result: Extract<ExportRun, { kind: "done" }>;
      submission: Submission;
    };

type SettingsRead = {
  attempt: Extract<OwnedRun, { kind: "done" }>;
  revision: number;
  controller: AbortController;
};

type Observation = { read: SettingsRead; evidence: ExportEvidence };

function isHostProject(
  path: string | null,
  guestMode: string | null,
): path is string {
  return (
    path !== null && path !== "" && guestMode === null && isHostProjectKey(path)
  );
}

type ExportModelNeed = ModelNeeded & { submission: Submission };

function withEditHead(head: string) {
  return (request: ExportRequest | null) =>
    request && request.edits !== undefined
      ? { ...request, edits: head }
      : request;
}

export function ExportFlowProvider({ children }: { children: ReactNode }) {
  const projectPath = useDawStore((s) => s.projectPath);
  const activityJob = useDawStore((s) => s.activityJob);
  const projectEpoch = useDawStore((s) => s.projectEpoch);
  const guestMode = useDawStore((s) => s.guestMode);
  const stage = useDawStore((s) => s.stage);
  const [ownedRun, setRun] = useState<OwnedRun>({ kind: "idle" });
  const run = ownedRun.kind === "done" ? ownedRun.result : ownedRun;
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [controls, setControls] = useState(initialControls);
  const currentControls = useRef(controls);
  const transitionControls = useCallback((event: ControlEvent) => {
    const current = currentControls.current;
    let next: Controls;
    switch (event.kind) {
      case "formats":
        next = {
          ...current,
          formats: { kind: "operator", keys: [...event.keys] },
          inputOwner: Symbol(),
        };
        break;
      case "target":
        next = { ...current, target: event.target, inputOwner: Symbol() };
        break;
      case "admitted":
        if (event.inputOwner !== current.inputOwner) return;
        next = { ...current, target: event.target };
        break;
      case "reset":
        next = initialControls();
        break;
    }
    currentControls.current = next;
    setControls(next);
  }, []);
  const selected = useMemo(
    () =>
      controls.formats.kind === "configured"
        ? (settings?.configured ?? [])
        : controls.formats.keys,
    [controls.formats, settings],
  );
  const loudness = controls.target;
  const [reloads, setReloads] = useState(0);
  const [loadedGeneration, setLoadedGeneration] = useState(0);
  const generation = useRef(0);
  const [readRevision, setReadRevision] = useState(0);
  const revision = useRef(0);
  const activeRead = useRef<SettingsRead | null>(null);
  const [observation, setObservation] = useState<Observation | null>(null);
  const invalidateRead = useCallback(() => {
    revision.current += 1;
    activeRead.current?.controller.abort();
    activeRead.current = null;
    setObservation(null);
    setReadRevision(revision.current);
  }, []);
  const setSelected = useCallback(
    (keys: readonly string[]) => {
      invalidateRead();
      transitionControls({ kind: "formats", keys });
    },
    [invalidateRead, transitionControls],
  );
  const setLoudness = useCallback(
    (choice: LoudnessId | null) => {
      invalidateRead();
      transitionControls({ kind: "target", target: choice });
    },
    [invalidateRead, transitionControls],
  );
  const [request, setRequest] = useState<ExportRequest | null>(null);
  const restart = useRef<(need: ExportModelNeed) => void>(() => undefined);
  const {
    stop: needs,
    stopFor,
    clear,
  } = useModelResume<ExportModelNeed>((need) => restart.current(need));
  const activeRun = useRef<AbortController | null>(null);
  const runRef = useRef(run);
  runRef.current = run;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const settingsErrorRef = useRef(settingsError);
  settingsErrorRef.current = settingsError;

  useEffect(() => {
    activeRun.current?.abort();
    activeRun.current = null;
    setRun({ kind: "idle" });
    setSettings(null);
    setSettingsError(null);
    transitionControls({ kind: "reset" });
    setRequest(null);
    setLoadedGeneration(0);
    clear();
  }, [projectPath, projectEpoch, guestMode, clear, transitionControls]);

  useEffect(() => () => activeRun.current?.abort(), []);

  useEffect(
    () =>
      useDawStore.subscribe((next, previous) => {
        if (
          next.projectPath !== previous.projectPath ||
          next.projectEpoch !== previous.projectEpoch ||
          next.guestMode !== previous.guestMode ||
          (next.stage === "deliver") !== (previous.stage === "deliver")
        )
          invalidateRead();
      }),
    [invalidateRead],
  );

  useEffect(() => {
    if (!isHostProject(projectPath, guestMode)) return;
    let live = true;
    const ownsCatalog = () => {
      const current = useDawStore.getState();
      return (
        live &&
        reloads === generation.current &&
        current.projectPath === projectPath &&
        current.projectEpoch === projectEpoch &&
        current.guestMode === guestMode
      );
    };
    loadPipelineConfig(projectPath)
      .then((res) => {
        if (!ownsCatalog()) return;
        const next = exportSettingsFromConfig(res.config);
        setSettingsError(null);
        setSettings(next);
      })
      .catch((err: unknown) => {
        if (ownsCatalog()) setSettingsError(errorMessage(err));
      })
      .finally(() => {
        if (ownsCatalog()) setLoadedGeneration(reloads);
      });
    return () => {
      live = false;
    };
  }, [projectPath, projectEpoch, guestMode, reloads]);

  const start = useCallback(
    async (submission: Submission, resumedModelId: string | null = null) => {
      const {
        projectPath: path,
        projectEpoch: epoch,
        formats,
        target,
        request: asked,
      } = submission;
      const store = useDawStore.getState();
      if (
        !isHostProject(path, store.guestMode) ||
        store.projectPath !== path ||
        store.projectEpoch !== epoch ||
        (activeRun.current && !activeRun.current.signal.aborted)
      )
        return;

      const controller = new AbortController();
      const { signal } = controller;
      activeRun.current = controller;
      invalidateRead();
      if (resumedModelId === null) clear();
      const unsubscribe = useDawStore.subscribe((state) => {
        if (
          state.projectPath !== path ||
          state.projectEpoch !== epoch ||
          state.guestMode !== null
        )
          controller.abort();
      });
      signal.addEventListener("abort", unsubscribe, { once: true });
      const isCurrent = () =>
        activeRun.current === controller && !signal.aborted;
      const running: ExportRun = {
        kind: "running",
        jobId: null,
        cancelling: false,
        cancelError: null,
      };
      setRequest(asked);
      runRef.current = running;
      setRun(running);
      let receipt: ExportReceipt | null = null;
      const finish = (kind: "done" | "cancelled") => {
        const finishedAt = Date.now();
        if (receipt?.kind === "named")
          setRequest({ ...asked, edits: receipt.editHeadId });
        else if (receipt?.editHeadId !== undefined)
          setRequest(withEditHead(receipt.editHeadId));
        if (kind === "cancelled") setRun({ kind, receipt, finishedAt });
        else if (receipt)
          setRun({ kind, result: { kind, receipt, finishedAt }, submission });
      };
      try {
        await runAnnouncedJob(() => startExportJob(path, formats, target), {
          kind: "export",
          failLabel: "Export failed",
          signal,
          summarizeResult: (job) => {
            receipt = readExportReceipt(job, target);
            return receipt ? { copy: receiptCopy(receipt) } : null;
          },
          onStart: (job) => {
            if (!isCurrent()) return;
            transitionControls({
              kind: "admitted",
              target,
              inputOwner: submission.inputOwner,
            });
            const history = useDawStore.getState().project?.history;
            const head =
              history && target === null ? editHeadOf(history) : undefined;
            if (head !== undefined) setRequest(withEditHead(head));
            setRun((r) => (r.kind === "running" ? { ...r, jobId: job.id } : r));
          },
        });
        if (isCurrent()) finish("done");
      } catch (err) {
        if (!isCurrent()) return;
        if (isAbortError(err)) {
          setRun({ kind: "idle" });
        } else if (
          isModelNeeded(err) &&
          useDawStore.getState().stage === "deliver" &&
          resumedModelId !== err.model.id
        ) {
          setRun({ kind: "idle" });
          stopFor({
            ...err.model,
            submission,
          });
        } else if (isModelNeeded(err)) {
          setRun({ kind: "failed", reason: notDownloadedLine(err.model) });
        } else if (err instanceof JobCancelledError) {
          finish("cancelled");
        } else {
          setRun({ kind: "failed", reason: errorMessage(err) });
        }
      } finally {
        signal.removeEventListener("abort", unsubscribe);
        unsubscribe();
        if (activeRun.current === controller) activeRun.current = null;
      }
    },
    [stopFor, clear, invalidateRead, transitionControls],
  );

  restart.current = ({ id, submission }) => void start(submission, id);

  const cancel = useCallback(async () => {
    const r = runRef.current;
    const controller = activeRun.current;
    if (
      !controller ||
      controller.signal.aborted ||
      r.kind !== "running" ||
      r.jobId == null
    )
      return;
    setRun({ ...r, cancelling: true, cancelError: null });
    try {
      await cancelPipelineRun(r.jobId);
    } catch (err) {
      if (activeRun.current !== controller || controller.signal.aborted) return;
      setRun((now) =>
        now.kind === "running" && now.jobId === r.jobId
          ? { ...now, cancelling: false, cancelError: errorMessage(err) }
          : now,
      );
    }
  }, []);

  const reload = useCallback(() => {
    invalidateRead();
    generation.current += 1;
    setReloads(generation.current);
    return generation.current;
  }, [invalidateRead]);
  const again = useCallback(() => {
    setRun({ kind: "idle" });
    if (settingsErrorRef.current !== null) reload();
  }, [reload]);

  const completed =
    ownedRun.kind === "done" &&
    ownedRun.submission.projectPath === projectPath &&
    ownedRun.submission.projectEpoch === projectEpoch &&
    isHostProject(projectPath, guestMode) &&
    stage === "deliver"
      ? ownedRun
      : null;
  const catalogReady =
    loadedGeneration === reloads &&
    (settingsError === null ? settings !== null : settings === null);
  let intent: "same" | "different" | "unknown" = "unknown";
  if (completed) {
    const { formats, target } = completed.submission;
    if (
      target !== loudness ||
      (settings && hasUnavailableFormats(settings, selected))
    )
      intent = "different";
    else if (catalogReady) {
      const liveFormats = settings && selectedFormats(settings, selected);
      const expectedFormats =
        formats ?? (settings && selectedFormats(settings, settings.configured));
      intent = sameExportFormats(expectedFormats, liveFormats)
        ? "same"
        : "different";
    }
  }

  useEffect(() => {
    if (!completed?.result.receipt.appliedSettings || intent !== "same") return;
    const {
      projectPath: path,
      projectEpoch: epoch,
      formats,
      target,
    } = completed.submission;
    const read: SettingsRead = {
      attempt: completed,
      revision: readRevision,
      controller: new AbortController(),
    };
    const ownsRead = () => {
      const current = useDawStore.getState();
      return (
        revision.current === read.revision &&
        current.projectPath === path &&
        current.projectEpoch === epoch &&
        current.guestMode === null &&
        current.stage === "deliver"
      );
    };
    if (!ownsRead()) return;
    activeRead.current = read;
    void readExportSettings(path, formats, target, read.controller.signal)
      .then((evidence) => {
        if (activeRead.current === read && ownsRead())
          setObservation(evidence ? { read, evidence } : null);
      })
      .catch(() => {
        if (activeRead.current === read && ownsRead()) setObservation(null);
      });
    return () => {
      if (activeRead.current === read) activeRead.current = null;
      read.controller.abort();
    };
  }, [completed, intent, readRevision]);

  const applied = completed?.result.receipt.appliedSettings;
  let settingsStatus: ExportSettingsStatus = "unknown";
  if (intent === "different") settingsStatus = "different";
  else if (
    intent === "same" &&
    applied &&
    observation &&
    observation.read.attempt === completed &&
    observation.read.revision === readRevision
  ) {
    settingsStatus =
      observation.evidence.basis === applied.basis ? "match" : "different";
  }

  const job =
    run.kind === "running" &&
    activityJob != null &&
    activityJob.id === run.jobId
      ? activityJob
      : null;
  const value = useMemo<ExportFlow>(
    () => ({
      run,
      job,
      settings,
      settingsError,
      settingsStatus,
      loading:
        settings === null && settingsError === null && projectPath !== null,
      loadedGeneration,
      selected,
      setSelected,
      loudness,
      setLoudness,
      needs,
      request,
      start: (keys, asked) => {
        const { projectPath, projectEpoch, guestMode } = useDawStore.getState();
        if (
          !isHostProject(projectPath, guestMode) ||
          (activeRun.current && !activeRun.current.signal.aborted)
        )
          return;
        const current = settingsRef.current;
        if (current && hasUnavailableFormats(current, keys)) return;
        const formats = resolveExport(current, keys);
        if (current && formats?.length === 0 && !current.wav) return;
        const initialSubmission: Submission = {
          inputOwner: currentControls.current.inputOwner,
          projectPath,
          projectEpoch,
          formats,
          target: asked.namedTarget ?? null,
          request: {
            ...asked,
            settings: { ...asked.settings, formats: [...keys] },
          },
        };
        void start(initialSubmission);
      },
      cancel: () => void cancel(),
      again,
      reload,
    }),
    [
      run,
      job,
      settings,
      settingsError,
      settingsStatus,
      projectPath,
      loadedGeneration,
      selected,
      setSelected,
      loudness,
      setLoudness,
      needs,
      request,
      start,
      cancel,
      again,
      reload,
    ],
  );
  return <Flow.Provider value={value}>{children}</Flow.Provider>;
}
