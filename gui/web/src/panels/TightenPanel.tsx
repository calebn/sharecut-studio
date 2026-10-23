import {
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { startPipelineRun } from "../api";
import { commandLabel } from "../commands/labels";
import { runPointerCommand } from "../commands/pointer";
import {
  getApplyingSuggested,
  subscribeApplyingSuggested,
} from "../commands/tighten";
import { askConfirm } from "../feedback/ask";
import { useTightenIntensityConfig } from "../hooks/useTightenIntensityConfig";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import {
  Button,
  CommandButton,
  EmptyState,
  Field,
  InlineError,
  SegmentedControl,
  ToggleButton,
} from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import { errorMessage } from "../utils/apiError";
import { isPipelineSlotBusy } from "../utils/pipeline";
import { revisableSuggestedBatch } from "../utils/suggestedBatch";
import {
  filterTightenHits,
  listTightenHits,
  type TightenClass,
  tightenHitCanGoTo,
  tightenHitCanPreview,
} from "../utils/tightenHits";
import {
  currentTightenIntensity,
  findHitsConfirm,
  findHitsRunError,
  tightenIntensityLabel,
  tightenIntensityOptions,
  tightenProposeRunOptions,
} from "../utils/tightenIntensity";
import { formatTimeShort } from "../utils/time";
import { AppliedSoundsList } from "./AppliedSoundsList";
import { BulkReviewWorking } from "./BulkReviewWorking";

const CLASS_FILTERS: { id: "all" | TightenClass; label: string }[] = [
  { id: "all", label: "All" },
  { id: "filler", label: "Filler" },
  { id: "pause", label: "Pause" },
  { id: "repetition", label: "Repetition" },
  { id: "restart", label: "Restart" },
];

const BADGE_LABEL: Record<string, string> = {
  risky: "Risky",
  review: "Review",
  ok: "OK",
};

/** Find hits request this panel started, scoped to the project it ran on. */
type FindRun = { path: string; jobId: string | null; error: string | null };

export function TightenPanel() {
  const {
    project,
    projectPath,
    guestMode,
    shareCapabilities,
    selection,
    pipelineJob,
    activityJob,
    setPipelineJob,
    announceStatus,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    selection: s.selection,
    pipelineJob: s.pipelineJob,
    activityJob: s.activityJob,
    setPipelineJob: s.setPipelineJob,
    announceStatus: s.announceStatus,
  }));
  const operation = useSyncExternalStore(
    subscribeApplyingSuggested,
    getApplyingSuggested,
  );
  const applying = operation?.projectPath === projectPath ? operation : null;
  const applyingIds = useMemo(() => new Set(applying?.ids ?? []), [applying]);
  const headingId = useId();
  const harshId = useId();
  const statusId = useId();
  const proposeErrorId = useId();
  const [classFilter, setClassFilter] = useState<"all" | TightenClass>("all");
  const [trackFilter, setTrackFilter] = useState("");
  const [harshOnly, setHarshOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [proposing, setProposing] = useState(false);
  const [findRun, setFindRun] = useState<FindRun | null>(null);

  const canApply = canApplyPass12(projectPath, guestMode, shareCapabilities);
  const intensityCfg = useTightenIntensityConfig(projectPath, canApply);
  const pipelineCfg = intensityCfg.cfg;
  const intensityOptions = tightenIntensityOptions(pipelineCfg);
  const intensity = currentTightenIntensity(pipelineCfg);
  const pipelineBusy =
    isPipelineSlotBusy(activityJob) || isPipelineSlotBusy(pipelineJob);
  const intensityDisabled =
    !canApply ||
    !pipelineCfg ||
    proposing ||
    intensityCfg.saving ||
    pipelineBusy;
  const findReason = !canApply
    ? "Only the host or an Editor can find hits."
    : proposing || intensityCfg.saving || pipelineBusy
      ? BUSY_REASON
      : !pipelineCfg
        ? "Wait for the tighten settings to load."
        : !intensity
          ? "Choose an intensity to find hits."
          : undefined;
  const currentRun = findRun?.path === projectPath ? findRun : null;
  const runError =
    currentRun?.error ??
    findHitsRunError(currentRun?.jobId ?? null, pipelineJob);
  const toolbarError = intensityCfg.saveError ?? runError;

  async function onFindHits() {
    if (!intensity) return;
    const question = findHitsConfirm(hits.length);
    if (question && !(await askConfirm(question))) {
      return;
    }
    const path = projectPath;
    const tier = intensity;
    setProposing(true);
    setFindRun({ path, jobId: null, error: null });
    try {
      const fresh = await intensityCfg.fetchFresh();
      if (!fresh) return;
      const job = await startPipelineRun(
        path,
        tightenProposeRunOptions(fresh, tier),
      );
      if (useDawStore.getState().projectPath !== path) return;
      setPipelineJob(job);
      setFindRun({ path, jobId: job.id, error: null });
      announceStatus(`Finding tighten hits (${tightenIntensityLabel(tier)})…`);
    } catch (e) {
      setFindRun({ path, jobId: null, error: errorMessage(e) });
    } finally {
      setProposing(false);
    }
  }

  const hits = useMemo(
    () => listTightenHits(project?.pending_edits, project?.transcript ?? null),
    [project?.pending_edits, project?.transcript],
  );
  const tracks = useMemo(() => {
    const ids = new Set(hits.map((h) => h.track_id));
    return (project?.tracks ?? []).filter((t) => ids.has(t.id));
  }, [hits, project?.tracks]);
  const trackLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const t of project?.tracks ?? []) {
      labels[t.id] = t.label || t.speaker || t.id;
    }
    return labels;
  }, [project?.tracks]);
  const filtered = useMemo(
    () =>
      filterTightenHits(hits, {
        classFilter,
        trackId: trackFilter,
        harshOnly,
        query,
        trackLabels,
      }),
    [hits, classFilter, trackFilter, harshOnly, query, trackLabels],
  );
  useEffect(() => {
    useDawStore.getState().setTightenApplyScope({
      ids: filtered.map((h) => h.id),
    });
  }, [filtered]);
  const applyAllReason = !canApply
    ? "Only the host or an Editor can apply edits."
    : applying
      ? BUSY_REASON
      : filtered.length === 0
        ? "Nothing to apply with the current filters."
        : undefined;
  const selectedId = selection?.kind === "pending" ? selection.id : null;
  const appliedSounds = useMemo(
    () =>
      project
        ? revisableSuggestedBatch({
            history: project.history,
            pending_edits: project.pending_edits,
          })
        : [],
    [project],
  );

  if (!project) {
    return null;
  }

  const trackLabel = (id: string) =>
    project.tracks.find((t) => t.id === id)?.label ||
    project.tracks.find((t) => t.id === id)?.speaker ||
    id;

  return (
    <section className="tighten-panel" aria-labelledby={headingId}>
      <header className="tighten-toolbar">
        <h2 id={headingId} className="tighten-heading sr-only">
          Tighten
        </h2>
        <Field label="Search hits">
          {(control) => (
            <input
              {...control}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Reason, snippet, track…"
            />
          )}
        </Field>
        <SegmentedControl className="tighten-filters" label="Class">
          {CLASS_FILTERS.map((f) => (
            <ToggleButton
              key={f.id}
              quiet
              pressed={classFilter === f.id}
              onClick={() => setClassFilter(f.id)}
            >
              {f.label}
            </ToggleButton>
          ))}
        </SegmentedControl>
        <Field label="Track">
          {(control) => (
            <select
              {...control}
              value={trackFilter}
              onChange={(e) => setTrackFilter(e.target.value)}
            >
              <option value="">All tracks</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label || t.speaker || t.id}
                </option>
              ))}
            </select>
          )}
        </Field>
        <label className="tighten-check" htmlFor={harshId}>
          <input
            id={harshId}
            type="checkbox"
            checked={harshOnly}
            onChange={(e) => setHarshOnly(e.target.checked)}
          />
          Harsh cuts only
        </label>
      </header>

      <div className="tighten-toolbar">
        <Field label="Intensity">
          {(control) => (
            <select
              {...control}
              value={intensity ?? ""}
              disabled={intensityDisabled}
              onChange={(e) => void intensityCfg.setIntensity(e.target.value)}
            >
              {intensityOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {tightenIntensityLabel(opt)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Button
          onClick={() => void onFindHits()}
          disabledReason={findReason}
          aria-describedby={toolbarError ? proposeErrorId : undefined}
        >
          {proposing ? "Starting…" : "Find hits"}
        </Button>
        <div id={proposeErrorId}>
          <InlineError message={intensityCfg.saveError} />
          <InlineError
            origin="state"
            message={intensityCfg.saveError ? null : runError}
          />
        </div>
        <InlineError
          origin="state"
          message={
            intensityCfg.loadError
              ? `Could not load tighten settings: ${intensityCfg.loadError}`
              : null
          }
        />
        {intensityCfg.loadError ? (
          <Button onClick={intensityCfg.reload}>Retry</Button>
        ) : null}
      </div>

      <div className="tighten-bulk">
        <CommandButton
          commandId="tighten.applySuggested"
          variant="primary"
          args={{ ids: filtered.map((h) => h.id) }}
          disabledReason={applyAllReason}
          aria-busy={applying ? true : undefined}
        >
          {`${commandLabel("tighten.applySuggested")} (${filtered.length})`}
        </CommandButton>
        {applying ? (
          <BulkReviewWorking
            verb="Applying"
            count={applying.ids.length}
            startedAtSec={applying.startedAtSec}
          />
        ) : null}
      </div>

      <AppliedSoundsList
        sounds={appliedSounds}
        trackLabel={trackLabel}
        canChange={canApply}
      />

      <p id={statusId} className="tighten-status" aria-live="polite">
        {filtered.length} of {hits.length} hits
      </p>

      {filtered.length === 0 ? (
        <EmptyState
          action={
            hits.length === 0
              ? undefined
              : {
                  label: "Clear filters",
                  onClick: () => {
                    setClassFilter("all");
                    setTrackFilter("");
                    setHarshOnly(false);
                    setQuery("");
                  },
                }
          }
        >
          {hits.length === 0
            ? "No pending tighten decisions."
            : "No hits match these filters."}
        </EmptyState>
      ) : (
        <div className="tighten-table-wrap">
          <table className="tighten-table">
            <caption className="sr-only">Pending tighten decisions</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Track</th>
                <th scope="col">Class</th>
                <th scope="col">Snippet</th>
                <th scope="col">Risk</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((hit) => {
                const canGoTo = tightenHitCanGoTo(hit);
                const canPreview = tightenHitCanPreview(hit);
                const t = hit.timeline_start;
                const timeLabel = t != null ? formatTimeShort(t) : "unmapped";
                const selected = selectedId === hit.id;
                const rowLabel = `${timeLabel} ${trackLabel(hit.track_id)}`;
                return (
                  <tr
                    key={hit.id}
                    data-hit-id={hit.id}
                    className={selected ? "tighten-row--selected" : undefined}
                    onClick={
                      canGoTo
                        ? () =>
                            runPointerCommand("tighten.goToHit", {
                              id: hit.id,
                            })
                        : undefined
                    }
                  >
                    <td>
                      {t != null ? (
                        <Button
                          variant="link"
                          onClick={() =>
                            runPointerCommand("tighten.goToHit", {
                              id: hit.id,
                            })
                          }
                        >
                          {formatTimeShort(t)}
                        </Button>
                      ) : (
                        <span>Unmapped</span>
                      )}
                    </td>
                    <td>{trackLabel(hit.track_id)}</td>
                    <td>
                      {hit.label ?? hit.tightenClass}
                      {hit.suggested_action
                        ? ` · suggest ${hit.suggested_action}`
                        : ""}
                    </td>
                    <td className="tighten-snippet">
                      {hit.snippet || "No snippet"}
                    </td>
                    <td>
                      <span
                        className={`tighten-badge tighten-badge--${hit.riskBadge}`}
                      >
                        {BADGE_LABEL[hit.riskBadge]}
                      </span>
                    </td>
                    <td>{applyingIds.has(hit.id) ? "Applying…" : "Pending"}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="tighten-row-actions">
                        {canApply ? (
                          <>
                            <CommandButton
                              commandId="tighten.applyHit"
                              args={{ id: hit.id }}
                              disabledReason={
                                applying ? BUSY_REASON : undefined
                              }
                              className="tighten-decide"
                              aria-label={`Apply ${rowLabel}`}
                              short
                            />
                            <CommandButton
                              commandId="tighten.skipHit"
                              args={{ id: hit.id }}
                              disabledReason={
                                applying ? BUSY_REASON : undefined
                              }
                              className="tighten-decide"
                              aria-label={`Skip ${rowLabel}`}
                              short
                            />
                          </>
                        ) : null}
                        <CommandButton
                          commandId="tighten.previewHit"
                          args={{ id: hit.id }}
                          variant="link"
                          disabledReason={
                            canPreview
                              ? undefined
                              : "This hit is not on the timeline, so it cannot be previewed."
                          }
                          aria-label={`Preview ${rowLabel}`}
                          short
                        />
                        <CommandButton
                          commandId="tighten.goToHit"
                          args={{ id: hit.id }}
                          variant="link"
                          disabledReason={
                            canGoTo
                              ? undefined
                              : "This hit is not on the timeline, so there is nothing to go to."
                          }
                          aria-label={`Go to ${rowLabel}`}
                          short
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
