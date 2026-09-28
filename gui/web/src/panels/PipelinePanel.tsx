import {
  Fragment,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ANALYZE_WAIT_MS,
  analyzePipeline,
  cancelPipelineRun,
  loadPipelineConfig,
  loadTranscriptVocabulary,
  putPipelineConfig,
  startPipelineRun,
  waitForPipelineJob,
} from "../api";
import { useLatestRequest } from "../hooks/useLatestRequest";
import { useSingleFlight } from "../hooks/useSingleFlight";
import { StaleProgressCopy } from "../layout/StaleProgressCopy";
import { selectAgentPresent } from "../presence/presenceSummary";
import { useDaw } from "../state/useDaw";
import type {
  PipelineAnalyzeReason,
  PipelineAnalyzeResponse,
  PipelineConfigResponse,
  PipelineJobSnapshot,
  PipelineParamField,
  PipelineStepMeta,
} from "../types/pipeline";
import { Button, EmptyState, InlineError } from "../ui";
import { errorMessage } from "../utils/apiError";
import { getByPath, setByPath } from "../utils/configPath";
import {
  isAnalyzeJob,
  isPipelineKindJob,
  isPipelineRunning,
  isPipelineSlotBusy,
  isPipelineSlotJob,
  isTerminalJobStatus,
} from "../utils/pipeline";
import {
  pipelineKindLabel,
  pipelineProgressPercent,
  pipelineStatusLabel,
  pipelineUnitNoun,
  pipelineUnitsLabel,
  showIndeterminatePulse,
} from "../utils/pipelineProgress";
import { formatTimeShort } from "../utils/time";
import { confirmReplaceEdited } from "./confirmReplaceEdited";
import { formatAnalyzeFields } from "./pipelineAnalyzeFormat";
import { TranscriptVocabularyEditor } from "./TranscriptVocabularyEditor";
import {
  type PipelineRunMode,
  WhisperDownloadDialog,
  type WhisperDownloadRequest,
  WhisperModelPicker,
} from "./WhisperModelPicker";
import { WORD_ALIGNER_COMPONENT, WordAlignerStatus } from "./WordAlignerStatus";

const TRANSCRIBE_MODEL_PATH = "transcribe.model";
const TRANSCRIBE_STEP = "transcribe_tracks";
const FORCED_ALIGNMENT_PATH = "transcribe.forced_alignment.enabled";

const FOCUS_STEPS = new Set(["analyze_focus_cuts", "focus_from_transcript"]);
const TIGHTEN_STEPS = new Set([
  "analyze_fillers_pauses",
  "tighten_from_transcript",
]);

const GROUP_LABELS: Record<string, string> = {
  transcript: "Transcript",
  editorial: "Editorial",
  mix: "Mix / master",
};

function uniqueSteps(steps: PipelineStepMeta[]): PipelineStepMeta[] {
  const seen = new Set<string>();
  const out: PipelineStepMeta[] = [];
  for (const s of steps) {
    if (seen.has(s.id)) {
      continue;
    }
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** Analyze patch leaves are JSON scalars or arrays, so JSON text equality is exact. */
function sameLeafValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What an Analyze response shows: reasons, per-track rows, the patched leaf paths and whether they were applied. */
function analyzeResultView(result: PipelineAnalyzeResponse) {
  const patches = result.patches ?? {};
  const highlightPaths = new Set<string>();
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v != null && typeof v === "object" && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, p);
      } else {
        highlightPaths.add(p);
      }
    }
  };
  walk(patches, "");
  return {
    reasons: result.reasons,
    trackRows: result.report_summary?.tracks ?? [],
    highlightPaths,
    patches,
    applied: result.applied === true,
  };
}

function ParamControl({
  field,
  value,
  defaultValue,
  disabled,
  highlighted,
  onChange,
}: {
  field: PipelineParamField;
  value: unknown;
  defaultValue: unknown;
  disabled: boolean;
  highlighted: boolean;
  onChange: (v: unknown) => void;
}) {
  const display = value ?? defaultValue ?? "";
  const rangeHint =
    field.minimum != null && field.maximum != null
      ? `Range: ${field.minimum} … ${field.maximum}${field.unit ? ` ${field.unit}` : ""}`
      : field.enum
        ? `Options: ${field.enum.join(", ")}`
        : null;
  const displayText = formatUnknown(display);
  const defaultText = formatUnknown(defaultValue ?? "Not set");

  return (
    <label
      className={`pipeline-param${highlighted ? " pipeline-param-highlight" : ""}`}
    >
      <span className="pipeline-param-label">
        {field.label}
        {field.unit ? ` (${field.unit})` : ""}
      </span>
      {field.type === "boolean" ? (
        <input
          type="checkbox"
          checked={Boolean(display)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : field.type === "enum" && field.enum ? (
        <select
          value={displayText}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.enum.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === "string" ? "text" : "number"}
          value={display === undefined || display === null ? "" : displayText}
          disabled={disabled}
          min={field.minimum}
          max={field.maximum}
          step={field.type === "integer" ? 1 : "any"}
          onChange={(e) => {
            if (field.type === "string") {
              onChange(e.target.value);
              return;
            }
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? n : e.target.value);
          }}
        />
      )}
      <span className="pipeline-param-help">{field.description}</span>
      {rangeHint && <span className="pipeline-param-range">{rangeHint}</span>}
      <span className="pipeline-param-default">Default: {defaultText}</span>
    </label>
  );
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function whisperModelId(cfg: PipelineConfigResponse): string {
  const raw = getByPath(cfg.config, TRANSCRIBE_MODEL_PATH);
  if (typeof raw === "string" && raw) {
    return raw;
  }
  const def = getByPath(cfg.defaults, TRANSCRIBE_MODEL_PATH);
  return typeof def === "string" ? def : "large-v3-turbo";
}

function whisperModelCached(
  cfg: PipelineConfigResponse,
  modelId: string,
): boolean {
  const row = cfg.whisper_models?.find((m) => m.id === modelId);
  return row?.cached === true;
}

function transcribeStepEnabled(cfg: PipelineConfigResponse): boolean {
  return cfg.enabled_steps.includes(TRANSCRIBE_STEP);
}

function pipelineRunOptions(
  cfg: PipelineConfigResponse,
  selection: { fromStep: string; onlyStep: string },
  mode: PipelineRunMode,
  overwriteEdited: boolean,
): NonNullable<Parameters<typeof startPipelineRun>[1]> {
  const fromTranscribe = mode !== "run";
  return {
    fromStep: fromTranscribe
      ? TRANSCRIBE_STEP
      : selection.fromStep || undefined,
    onlyStep: fromTranscribe ? undefined : selection.onlyStep || undefined,
    enabledSteps: fromTranscribe
      ? [...new Set([...cfg.enabled_steps, TRANSCRIBE_STEP])]
      : cfg.enabled_steps,
    unattended: cfg.unattended,
    config: cfg.config,
    useWorkingSet: true,
    forceTranscribe: mode === "retranscribe",
    retimeWords: mode === "retime",
    overwriteEdited: fromTranscribe && overwriteEdited,
  };
}

/** True while `transcribe.forced_alignment.enabled` is on (config, falling back to defaults). */
function forcedAlignmentOn(cfg: PipelineConfigResponse): boolean {
  return Boolean(
    getByPath(cfg.config, FORCED_ALIGNMENT_PATH) ??
      getByPath(cfg.defaults, FORCED_ALIGNMENT_PATH),
  );
}

export function PipelinePanel() {
  const {
    projectPath,
    pipelineJob,
    activityJob,
    setPipelineJob,
    setActivityJob,
    setActiveTab,
  } = useDaw((s) => ({
    projectPath: s.projectPath,
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    setPipelineJob: s.setPipelineJob,
    setActivityJob: s.setActivityJob,
    setActiveTab: s.setActiveTab,
  }));
  const agentRecent = useDaw(selectAgentPresent);
  const [cfg, setCfg] = useState<PipelineConfigResponse | null>(null);
  const [whisperPending, setWhisperPending] =
    useState<WhisperDownloadRequest | null>(null);
  const [selectedStep, setSelectedStep] = useState<string>("balance_tracks");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [fromStep, setFromStep] = useState("");
  const [onlyStep, setOnlyStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<PipelineAnalyzeReason[]>([]);
  const [reasonsApplied, setReasonsApplied] = useState(true);
  const [trackRows, setTrackRows] = useState<Array<Record<string, unknown>>>(
    [],
  );
  const [highlightPaths, setHighlightPaths] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  /** A second Re-time words click before `retiming` re-renders must not start a second re-time. */
  const { busy: retiming, run: runRetime } = useSingleFlight();
  const [analyzing, setAnalyzing] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const persistRequest = useLatestRequest();
  const analyzeRequest = useLatestRequest();
  /** The newest config PUT, so Analyze can wait for a write that overlapped its scan. */
  const lastPersist = useRef<Promise<unknown>>(Promise.resolve());
  /** Aborts the wait on the running Analyze job's stream (project switch / re-run). */
  const analyzeAbort = useRef<AbortController | null>(null);
  /** The Analyze job this tab started most recently; its own promise renders its result. */
  const ownAnalyzeId = useRef<string | null>(null);
  /** The running Analyze started elsewhere (another tab or viewer) that this tab follows for the current project; its result renders here once. Reset on a project switch. */
  const remoteAnalyzeId = useRef<string | null>(null);
  /** Project path each followed remote Analyze job id was claimed under: another project's pane never adopts it, and switching back to its project follows it again. */
  const remoteAnalyzeProject = useRef(new Map<string, string>());
  /** Stops following that remote Analyze job's stream (project switch / unmount / a newer remote job). */
  const remoteAnalyzeAbort = useRef<AbortController | null>(null);
  const stepCheckboxes = useRef(new Map<string, HTMLInputElement>());

  const slotJob =
    (isPipelineSlotJob(activityJob) ? activityJob : null) ??
    (isPipelineSlotJob(pipelineJob) ? pipelineJob : null);
  const slotBusy = isPipelineSlotBusy(slotJob);
  /** A running Analyze shows its own progress here instead of the slot-busy notice. */
  const analyzeJob = slotBusy && isAnalyzeJob(slotJob) ? slotJob : null;
  const foreignSlotBusy =
    slotBusy &&
    slotJob != null &&
    !isPipelineKindJob(slotJob) &&
    analyzeJob == null;
  const pipelineRunning =
    isPipelineKindJob(pipelineJob) && isPipelineRunning(pipelineJob);
  const running = slotBusy;

  useEffect(() => {
    // A project switch drops in-flight writes and the previous project's Analyze results.
    persistRequest.invalidate();
    analyzeRequest.invalidate();
    analyzeAbort.current?.abort();
    analyzeAbort.current = null;
    // ownAnalyzeId is kept: the switch cancels that job, so its later frames are never adopted
    // as a remote Analyze. remoteAnalyzeId resets so that switching back to a remote job's project
    // while it still runs follows it again. remoteAnalyzeProject keeps it out of other projects'
    // panes. The cleanup below stops the remote wait.
    remoteAnalyzeId.current = null;
    setAnalyzing(false);
    setReasons([]);
    setTrackRows([]);
    setHighlightPaths(new Set());
    let cancelled = false;
    void loadPipelineConfig(projectPath)
      .then((data) => {
        if (!cancelled) {
          setCfg(data);
          setSelectedStep((prev) =>
            data.steps.some((s) => s.id === prev)
              ? prev
              : (data.steps[0]?.id ?? prev),
          );
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(errorMessage(e));
        }
      });
    return () => {
      cancelled = true;
      // Stop following another viewer's Analyze (project switch or unmount).
      remoteAnalyzeAbort.current?.abort();
      remoteAnalyzeAbort.current = null;
    };
  }, [projectPath, persistRequest, analyzeRequest]);

  /** Render a shared Analyze job's terminal result in a tab that watched it run elsewhere. */
  const showRemoteAnalyze = useEffectEvent(
    async (done: PipelineJobSnapshot, signal: AbortSignal) => {
      if (signal.aborted || done.id === ownAnalyzeId.current) {
        return;
      }
      if (done.result == null) {
        return; // cancelled before a result: nothing was applied
      }
      const view = analyzeResultView(
        done.result as unknown as PipelineAnalyzeResponse,
      );
      setReasons(view.reasons);
      setReasonsApplied(view.applied);
      setTrackRows(view.trackRows);
      if (!view.applied) {
        // Proposals only (`apply: false`): the working set is unchanged, so nothing is
        // highlighted as changed and there is nothing to re-read.
        setHighlightPaths(new Set());
        return;
      }
      setHighlightPaths(view.highlightPaths);
      // The other viewer's apply patched the working set; re-read it once any local
      // config write settles, so a GET served before that PUT cannot win.
      await rereadAfterAnalyze(view.patches, () => !signal.aborted);
    },
  );

  useEffect(() => {
    const j = activityJob;
    if (
      j == null ||
      !isAnalyzeJob(j) ||
      isTerminalJobStatus(j.status) ||
      j.id === ownAnalyzeId.current ||
      j.id === remoteAnalyzeId.current ||
      (remoteAnalyzeProject.current.get(j.id) ?? projectPath) !== projectPath
    ) {
      return;
    }
    // Started elsewhere (another tab or viewer). Follow the job's own stream, not
    // activityJob: a concurrent agent job can take over the Activity primary before
    // Analyze finishes, so its terminal snapshot may never reach activityJob.
    remoteAnalyzeId.current = j.id;
    remoteAnalyzeProject.current.set(j.id, projectPath);
    remoteAnalyzeAbort.current?.abort();
    const abort = new AbortController();
    remoteAnalyzeAbort.current = abort;
    void waitForPipelineJob(j.id, {
      timeoutMs: ANALYZE_WAIT_MS,
      signal: abort.signal,
    })
      .then((done) => showRemoteAnalyze(done, abort.signal))
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(errorMessage(e));
        }
      })
      .finally(() => {
        if (remoteAnalyzeAbort.current === abort) {
          remoteAnalyzeAbort.current = null;
        }
      });
  }, [activityJob, projectPath]);

  const stepsUnique = useMemo(() => (cfg ? uniqueSteps(cfg.steps) : []), [cfg]);

  const grouped = useMemo(() => {
    const map = new Map<string, PipelineStepMeta[]>();
    for (const s of stepsUnique) {
      const list = map.get(s.group) ?? [];
      list.push(s);
      map.set(s.group, list);
    }
    return map;
  }, [stepsUnique]);

  const selectedMeta = stepsUnique.find((s) => s.id === selectedStep) ?? null;

  const paramsForStep = useMemo(() => {
    if (!cfg || !selectedMeta) {
      return [] as PipelineParamField[];
    }
    const sections = new Set(selectedMeta.param_sections);
    return cfg.params.filter(
      (p) =>
        sections.has(p.section) ||
        p.affects.includes(selectedMeta.id) ||
        (selectedMeta.id === "ingest_tracks" && p.section === "performance"),
    );
  }, [cfg, selectedMeta]);

  const persist = async (patch: {
    config?: Record<string, unknown>;
    enabled_steps?: string[];
    unattended?: boolean;
    reset?: boolean;
  }) => {
    return applyPersist(patch, persistRequest.begin());
  };

  const applyPersist = async (
    patch: {
      config?: Record<string, unknown>;
      enabled_steps?: string[];
      unattended?: boolean;
      reset?: boolean;
    },
    token: number,
  ) => {
    const pending = putPipelineConfig(projectPath, patch);
    lastPersist.current = pending;
    const next = await pending;
    if (persistRequest.isCurrent(token)) {
      setCfg(next);
    }
    return next;
  };

  /**
   * Re-read the working set after Analyze patched it, once any in-flight config PUT
   * settles, then keep highlighting only fields that still hold Analyze's patched
   * value. Skips the re-read when a newer write began meanwhile: that write's own
   * response carries the server state. `stillCurrent` drops an abandoned caller.
   */
  const rereadAfterAnalyze = async (
    patches: Record<string, unknown>,
    stillCurrent: () => boolean,
  ): Promise<void> => {
    const latest = persistRequest.peek();
    await lastPersist.current.catch(() => undefined);
    // If that write failed, onParamChange's snapshot revert either already ran or is
    // retired by the reload's begin() below, so the re-read deliberately wins.
    if (!stillCurrent() || !persistRequest.isCurrent(latest)) {
      return;
    }
    const reload = persistRequest.begin();
    const fresh = await loadPipelineConfig(projectPath);
    if (stillCurrent() && persistRequest.isCurrent(reload)) {
      setCfg(fresh);
      // A write that landed after apply_patches can replace a patched value; only
      // highlight fields that still hold Analyze's value.
      setHighlightPaths(
        (prev) =>
          new Set(
            [...prev].filter((p) =>
              sameLeafValue(getByPath(fresh.config, p), getByPath(patches, p)),
            ),
          ),
      );
    }
  };

  /** Resolves true only when this toggle's config is the one now shown in `cfg`. */
  const toggleStep = async (
    stepId: string,
    enabled: boolean,
  ): Promise<boolean> => {
    if (!cfg) {
      return false;
    }
    setError(null);
    const set = new Set(cfg.enabled_steps);
    if (enabled) {
      set.add(stepId);
    } else {
      set.delete(stepId);
    }
    let nextConfig = cfg.config;
    if (FOCUS_STEPS.has(stepId)) {
      nextConfig = setByPath(
        nextConfig,
        "focus.enabled",
        [...FOCUS_STEPS].some((s) => set.has(s)),
      );
    }
    if (TIGHTEN_STEPS.has(stepId)) {
      nextConfig = setByPath(
        nextConfig,
        "tighten.enabled",
        [...TIGHTEN_STEPS].some((s) => set.has(s)),
      );
    }
    const patch: {
      config?: Record<string, unknown>;
      enabled_steps: string[];
    } = { enabled_steps: [...set] };
    if (nextConfig !== cfg.config) {
      patch.config = nextConfig;
    }
    const token = persistRequest.begin();
    try {
      await applyPersist(patch, token);
      // False when a later write (param edit, another toggle, Analyze) overtook this one.
      return persistRequest.isCurrent(token);
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  const uncheckSuggestedStep = async (stepId: string) => {
    if (await toggleStep(stepId, false)) {
      // The Uncheck button unmounts once the step is off; keep keyboard focus in place.
      stepCheckboxes.current.get(stepId)?.focus();
    }
  };

  const onParamChange = async (path: string, value: unknown) => {
    if (!cfg) {
      return;
    }
    setError(null);
    const snapshot = cfg;
    const nextConfig = setByPath(cfg.config, path, value);
    setCfg({ ...cfg, config: nextConfig });
    const token = persistRequest.begin();
    try {
      await applyPersist({ config: nextConfig }, token);
      if (persistRequest.isCurrent(token)) {
        setHighlightPaths((prev) => {
          const n = new Set(prev);
          n.delete(path);
          return n;
        });
      }
    } catch (e) {
      if (persistRequest.isCurrent(token)) {
        setCfg(snapshot);
      }
      setError(errorMessage(e));
    }
  };

  const onAnalyze = async () => {
    setError(null);
    setAnalyzing(true);
    const token = analyzeRequest.begin();
    const persistMark = persistRequest.peek();
    analyzeAbort.current?.abort();
    const abort = new AbortController();
    analyzeAbort.current = abort;
    try {
      const result = await analyzePipeline(projectPath, {
        apply: true,
        signal: abort.signal,
        // Seed the slot job so Cancel + live progress show before the first SSE frame.
        onJob: (started) => {
          ownAnalyzeId.current = started.id;
          if (analyzeRequest.isCurrent(token)) {
            setActivityJob(started);
          }
        },
      });
      if (!analyzeRequest.isCurrent(token)) {
        return;
      }
      if (result == null) {
        // Cancelled before the scan finished: nothing was applied.
        return;
      }
      const view = analyzeResultView(result);
      setReasons(view.reasons);
      setReasonsApplied(view.applied);
      setTrackRows(view.trackRows);
      setHighlightPaths(view.highlightPaths);
      const patches = view.patches;
      const next = result.config ?? (await loadPipelineConfig(projectPath));
      if (!analyzeRequest.isCurrent(token)) {
        return;
      }
      if (persistRequest.isCurrent(persistMark)) {
        // No write began during the scan, so Analyze's config is the newest server state.
        persistRequest.invalidate();
        setCfg(next);
        return;
      }
      // The scan result is shown; the re-read below runs without holding Analyze busy.
      setAnalyzing(false);
      // A full-config PUT sent during the scan may have landed after apply_patches and
      // replaced the patched config, so re-read the server once that write settles.
      await rereadAfterAnalyze(patches, () => analyzeRequest.isCurrent(token));
    } catch (e) {
      if (analyzeRequest.isCurrent(token)) {
        setError(errorMessage(e));
      }
    } finally {
      if (analyzeAbort.current === abort) {
        analyzeAbort.current = null;
      }
      if (analyzeRequest.isCurrent(token)) {
        setAnalyzing(false);
      }
    }
  };

  const onReset = async () => {
    setError(null);
    setReasons([]);
    setTrackRows([]);
    setHighlightPaths(new Set());
    try {
      await persist({ reset: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const onRun = async (
    mode: PipelineRunMode = "run",
    overwriteEdited = false,
  ) => {
    if (!cfg) {
      return;
    }
    // Re-time words needs Whisper too: its run still transcribes any dialogue track that
    // has no stored transcript yet (only reused transcripts are re-timed from the ASR cache).
    if (transcribeStepEnabled(cfg) || mode !== "run") {
      const modelId = whisperModelId(cfg);
      if (!whisperModelCached(cfg, modelId)) {
        setWhisperPending({
          modelId,
          reason: mode,
          overwriteEdited,
        });
        return;
      }
    }
    setError(null);
    setStarting(true);
    try {
      const job = await startPipelineRun(
        projectPath,
        pipelineRunOptions(cfg, { fromStep, onlyStep }, mode, overwriteEdited),
      );
      setPipelineJob(job);
      setActiveTab("pipeline");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const refreshConfig = async () => {
    const data = await loadPipelineConfig(projectPath);
    setCfg(data);
    return data;
  };

  const onWhisperDownloaded = async (modelId: string) => {
    const reason = whisperPending?.reason;
    const overwriteEdited = whisperPending?.overwriteEdited ?? false;
    setWhisperPending(null);
    try {
      await onParamChange(TRANSCRIBE_MODEL_PATH, modelId);
      const next = await refreshConfig();
      if (
        reason !== undefined &&
        reason !== "select" &&
        whisperModelCached(next, modelId)
      ) {
        setCfg(next);
        setError(null);
        setStarting(true);
        try {
          const job = await startPipelineRun(
            projectPath,
            pipelineRunOptions(
              next,
              { fromStep, onlyStep },
              reason,
              overwriteEdited,
            ),
          );
          setPipelineJob(job);
          setActiveTab("pipeline");
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setStarting(false);
        }
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const onRetime = () =>
    runRetime(async () => {
      let edited: string[];
      try {
        edited =
          (await loadTranscriptVocabulary(projectPath)).edited_tracks ?? [];
      } catch (e) {
        setError(errorMessage(e));
        return;
      }
      const overwriteEdited = confirmReplaceEdited(edited, "Re-time words");
      if (overwriteEdited !== null) {
        await onRun("retime", overwriteEdited);
      }
    });

  const onCancel = async () => {
    try {
      const job = await cancelPipelineRun(slotJob?.id ?? pipelineJob?.id);
      if (isPipelineKindJob(job)) {
        setPipelineJob(job);
      } else {
        setPipelineJob(null);
      }
      setActivityJob(job);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const job: PipelineJobSnapshot | null =
    analyzeJob ??
    (isPipelineKindJob(pipelineJob) && !foreignSlotBusy ? pipelineJob : null);
  const pct = pipelineProgressPercent(job);
  const units = pipelineUnitsLabel(job, pipelineUnitNoun(job?.kind));
  const indeterminatePulse = showIndeterminatePulse(job);

  const failedStep = (id: string) =>
    job?.status === "error" &&
    (job.steps ?? []).some((s) => s.status === "error" && s.name === id);
  const waitingRefine = failedStep("require_transcript_refine");
  const waitingAlign = failedStep("require_align_accept");

  const blockedComponents = cfg
    ? Object.entries(cfg.components).filter(
        ([, c]) => !c.ok && (!c.opt_in || forcedAlignmentOn(cfg)),
      )
    : [];

  const openStep = (id: string) => {
    setSelectedStep(id);
    setDetailOpen(true);
  };

  return (
    <div className="pipeline-panel">
      <div className="pipeline-toolbar">
        <div className="pipeline-toolbar-actions">
          <Button
            className="pipeline-secondary-btn"
            disabled={running || starting || analyzing || !cfg}
            aria-busy={analyzing || undefined}
            onClick={() => void onAnalyze()}
          >
            {analyzing ? "Analyzing…" : "Analyze"}
          </Button>
          <Button
            className="pipeline-secondary-btn"
            disabled={running || starting || !cfg}
            onClick={() => void onReset()}
          >
            Reset
          </Button>
          {running && (
            <Button
              className="pipeline-secondary-btn"
              onClick={() => void onCancel()}
            >
              Cancel
            </Button>
          )}
        </div>
        <label className="pipeline-mode">
          Mode
          <select
            value={cfg?.unattended ? "batch" : "gates"}
            disabled={running || starting || !cfg}
            onChange={(e) => {
              void persist({ unattended: e.target.value === "batch" });
            }}
          >
            <option value="batch">Batch (waive align + refine)</option>
            <option value="gates">Leave gates open (resume later)</option>
          </select>
        </label>
        <Button
          variant="primary"
          className="pipeline-run-btn"
          disabled={running || starting || !cfg}
          aria-busy={starting || pipelineRunning || undefined}
          onClick={() => void onRun()}
        >
          {starting
            ? "Starting…"
            : pipelineRunning
              ? "Running…"
              : "Run pipeline"}
        </Button>
      </div>

      {agentRecent && (
        <p className="pipeline-ambient" role="status">
          Agent recently active in this session (optional).
        </p>
      )}

      <TranscriptVocabularyEditor
        key={projectPath}
        projectPath={projectPath}
        busy={running || starting}
        onRetranscribe={(overwriteEdited) =>
          void onRun("retranscribe", overwriteEdited)
        }
        refreshKey={
          pipelineJob && !isPipelineRunning(pipelineJob)
            ? `${pipelineJob.id}:${pipelineJob.status}`
            : ""
        }
      />

      {foreignSlotBusy && slotJob ? (
        <p className="pipeline-ambient" role="status">
          {slotJob.label || pipelineKindLabel(slotJob.kind)} is running. Cancel
          frees the pipeline slot
          {slotJob.message ? `: ${slotJob.message}` : "."}
        </p>
      ) : null}

      {!cfg?.unattended && (
        <p className="pipeline-hint">
          Leave-gates mode: if align or refine blocks, clear it via agent skill
          or CLI, then resume with From step after the gate.
        </p>
      )}

      {blockedComponents.length > 0 && (
        <ul className="pipeline-components">
          {blockedComponents.map(([id, c]) => (
            <li key={id}>
              Missing {id}
              {c.hint ? `: ${c.hint}` : ""}
              {c.bootstrap ? ` (${c.bootstrap})` : ""}
            </li>
          ))}
        </ul>
      )}

      {(reasons.length > 0 || trackRows.length > 0) && (
        <div className="pipeline-reasons">
          {reasons.length > 0 && (
            <>
              <strong>
                {reasonsApplied
                  ? "Analyze suggestions applied"
                  : "Analyze suggestions (not applied)"}
              </strong>
              <ul>
                {reasons.map((r, i) => {
                  const evidence = formatAnalyzeFields(r.evidence ?? {});
                  const skips = (r.suggested_skip_steps ?? []).filter((s) =>
                    cfg?.enabled_steps.includes(s),
                  );
                  return (
                    <li key={`${r.code}-${r.track_id ?? ""}-${i}`}>
                      {r.message}
                      {evidence && (
                        <div className="pipeline-reason-evidence">
                          {evidence}
                        </div>
                      )}
                      {skips.map((stepId) => (
                        <Button
                          key={stepId}
                          variant="link"
                          className="pipeline-reason-skip"
                          disabled={running || starting || !cfg}
                          onClick={() => void uncheckSuggestedStep(stepId)}
                        >
                          Uncheck{" "}
                          {cfg?.steps.find((s) => s.id === stepId)?.title ??
                            stepId}
                        </Button>
                      ))}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {trackRows.length > 0 && (
            <details className="pipeline-analyze-tracks">
              <summary>Per-track measurements ({trackRows.length})</summary>
              <ul>
                {trackRows.map((row, i) => {
                  const rawTid = row.track_id;
                  const tid =
                    typeof rawTid === "string" || typeof rawTid === "number"
                      ? String(rawTid)
                      : "?";
                  return (
                    <li key={`${tid}-${i}`}>
                      <strong>{tid}</strong>:{" "}
                      {formatAnalyzeFields(row, ["track_id"])}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </div>
      )}

      {error && <InlineError message={error} />}

      <div className="pipeline-master-detail">
        <div className="pipeline-step-list">
          {grouped.size === 0 ? (
            <EmptyState>Analyze to load the pipeline steps.</EmptyState>
          ) : null}
          {[...grouped.entries()].map(([group, steps]) => (
            <div key={group} className="pipeline-step-group">
              <div className="pipeline-step-group-title">
                {GROUP_LABELS[group] ?? group}
              </div>
              {steps.map((s) => {
                const enabled = cfg?.enabled_steps.includes(s.id) ?? false;
                const missing = s.requires_components.some(
                  (c) => cfg && cfg.components[c] && !cfg.components[c]!.ok,
                );
                return (
                  <div
                    key={`${s.id}-${s.index}`}
                    className={`pipeline-step-row${selectedStep === s.id ? " selected" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={running || starting || !cfg}
                      aria-label={`Enable ${s.title}`}
                      onChange={(e) => void toggleStep(s.id, e.target.checked)}
                      ref={(el) => {
                        if (el) {
                          stepCheckboxes.current.set(s.id, el);
                        } else {
                          stepCheckboxes.current.delete(s.id);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="pipeline-step-select"
                      onClick={() => openStep(s.id)}
                    >
                      <span>{s.title}</span>
                      {s.kind === "gate" && (
                        <span className="pipeline-badge">gate</span>
                      )}
                      {missing && (
                        <span className="pipeline-badge warn">deps</span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div
          className={`pipeline-step-detail${detailOpen ? " open" : ""}`}
          aria-label="Step parameters"
        >
          <button
            type="button"
            className="pipeline-detail-close"
            onClick={() => setDetailOpen(false)}
          >
            Close
          </button>
          {selectedMeta && cfg ? (
            <>
              <h2 className="pipeline-step-detail-title">
                {selectedMeta.title}
              </h2>
              <p className="pipeline-step-summary-text">
                {selectedMeta.summary}
              </p>
              {selectedMeta.depends_on.length > 0 && (
                <p className="pipeline-hint">
                  Depends on: {selectedMeta.depends_on.join(", ")}
                </p>
              )}
              <div className="pipeline-param-list">
                {paramsForStep
                  .filter((p) => showAdvanced || p.group === "common")
                  .map((field) => {
                    if (field.path === TRANSCRIBE_MODEL_PATH) {
                      const models = (cfg.whisper_models ?? []).map((m) => ({
                        id: m.id,
                        label: m.label,
                        size: m.size,
                        description: m.description,
                        cached: m.cached,
                      }));
                      const currentId = whisperModelId(cfg);
                      const displayId =
                        whisperPending?.reason === "select"
                          ? whisperPending.modelId
                          : currentId;
                      const defaultId = formatUnknown(
                        getByPath(cfg.defaults, field.path) ?? "large-v3-turbo",
                      );
                      return (
                        <WhisperModelPicker
                          key={field.path}
                          fieldLabel={field.label}
                          fieldDescription={field.description}
                          value={displayId}
                          defaultValue={defaultId}
                          models={models}
                          disabled={running || starting}
                          highlighted={highlightPaths.has(field.path)}
                          onSelectCached={(modelId) =>
                            void onParamChange(field.path, modelId)
                          }
                          onSelectMissing={(modelId, previousId) => {
                            setWhisperPending({
                              modelId,
                              previousId,
                              reason: "select",
                            });
                          }}
                        />
                      );
                    }
                    if (field.path === FORCED_ALIGNMENT_PATH) {
                      return (
                        <Fragment key={field.path}>
                          <ParamControl
                            field={field}
                            value={getByPath(cfg.config, field.path)}
                            defaultValue={getByPath(cfg.defaults, field.path)}
                            disabled={running || starting}
                            highlighted={highlightPaths.has(field.path)}
                            onChange={(v) => void onParamChange(field.path, v)}
                          />
                          {forcedAlignmentOn(cfg) ? (
                            <WordAlignerStatus
                              status={cfg.components[WORD_ALIGNER_COMPONENT]}
                              disabled={running || starting || retiming}
                              onDownloaded={() =>
                                void refreshConfig().catch((e: unknown) =>
                                  setError(errorMessage(e)),
                                )
                              }
                              onRetime={() => void onRetime()}
                            />
                          ) : null}
                        </Fragment>
                      );
                    }
                    return (
                      <ParamControl
                        key={field.path}
                        field={field}
                        value={getByPath(cfg.config, field.path)}
                        defaultValue={getByPath(cfg.defaults, field.path)}
                        disabled={running || starting}
                        highlighted={highlightPaths.has(field.path)}
                        onChange={(v) => void onParamChange(field.path, v)}
                      />
                    );
                  })}
              </div>
              <Button
                className="pipeline-secondary-btn"
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? "Hide advanced" : "Show advanced"}
              </Button>
            </>
          ) : (
            <p className="pipeline-hint">
              Select a step to edit its parameters.
            </p>
          )}
        </div>
      </div>

      <details
        className="pipeline-advanced-shortcuts"
        open={showShortcuts}
        onToggle={(e) =>
          setShowShortcuts((e.target as HTMLDetailsElement).open)
        }
      >
        <summary>From / Only shortcuts</summary>
        <div className="pipeline-controls">
          <label>
            From step
            <select
              value={fromStep}
              disabled={running || starting}
              onChange={(e) => setFromStep(e.target.value)}
            >
              <option value="">Start</option>
              {(cfg?.step_names ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Only step
            <select
              value={onlyStep}
              disabled={running || starting}
              onChange={(e) => setOnlyStep(e.target.value)}
            >
              <option value="">Full / from</option>
              {(cfg?.step_names ?? []).map((s) => (
                <option key={`only-${s}`} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>

      {waitingAlign && (
        <div className="pipeline-waiting" role={job ? undefined : "status"}>
          <p>
            Waiting on conversation alignment. Clear via agent skill /{" "}
            <code>podcast align done</code>, or switch to Batch mode and resume
            from the next step.
          </p>
        </div>
      )}

      {waitingRefine && (
        <div className="pipeline-waiting" role={job ? undefined : "status"}>
          <p>
            Waiting on transcript refine. Clear via agent skill /{" "}
            <code>podcast transcript refine-done</code>, or switch to Batch mode
            and resume from the next step.
          </p>
        </div>
      )}

      {job && (
        <>
          <div className="pipeline-summary">
            <div
              className="pipeline-live"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-busy={job.status === "running" || undefined}
            >
              <span className={`pipeline-status ${job.status}`}>
                {pipelineStatusLabel(job.status)}
              </span>
              {job.message ? (
                <span className="pipeline-headline">{job.message}</span>
              ) : null}
              {units ? <span>{units}</span> : null}
              {indeterminatePulse ? (
                <span
                  className="pipeline-pulse"
                  data-testid="pipeline-pulse"
                  aria-hidden="true"
                />
              ) : null}
            </div>
            <StaleProgressCopy
              lastProgressAt={job.last_progress_at}
              running={running}
              announce
            />
            <span className="pipeline-elapsed">
              Elapsed {formatTimeShort(job.elapsed_sec)}
            </span>
          </div>
          {pct != null ? (
            <div
              className="pipeline-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuenow={pct}
              aria-valuemax={100}
              aria-label={
                job.message ??
                (analyzeJob ? "Analyze progress" : "Pipeline progress")
              }
            >
              <div className="pipeline-bar-fill" style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          {job.error && <InlineError message={job.error} />}
          {analyzeJob == null && (
            <table className="pipeline-steps">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Status</th>
                  <th>Time</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {job.steps.map((s) => (
                  <tr key={`${s.name}-${s.elapsed_sec}`}>
                    <td>{s.name}</td>
                    <td
                      className={
                        s.status === "running"
                          ? "step-running"
                          : s.status === "ok"
                            ? "step-ok"
                            : s.status === "error"
                              ? "step-error"
                              : undefined
                      }
                    >
                      {s.status}
                    </td>
                    <td>{formatTimeShort(s.elapsed_sec)}</td>
                    <td className="pipeline-step-summary">
                      {s.error ?? s.summary ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <WhisperDownloadDialog
        pending={whisperPending}
        models={(cfg?.whisper_models ?? []).map((m) => ({
          id: m.id,
          label: m.label,
          size: m.size,
          description: m.description,
          cached: m.cached,
        }))}
        onDefer={(modelId) => {
          setWhisperPending(null);
          void onParamChange(TRANSCRIBE_MODEL_PATH, modelId);
        }}
        onCancel={() => setWhisperPending(null)}
        onDownloaded={(modelId) => void onWhisperDownloaded(modelId)}
      />
    </div>
  );
}
