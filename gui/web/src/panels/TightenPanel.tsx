import { useEffect, useId, useMemo, useState } from "react";
import { execute } from "../commands/execute";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import {
  Button,
  CommandButton,
  EmptyState,
  Field,
  SegmentedControl,
  ToggleButton,
} from "../ui";
import {
  applyAllSummary,
  eligibleApplyAllIds,
  filterTightenHits,
  listTightenHits,
  type TightenClass,
  tightenHitCanGoTo,
  tightenHitCanPreview,
} from "../utils/tightenHits";
import { formatTimeShort } from "../utils/time";

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

export function TightenPanel() {
  const { project, projectPath, guestMode, shareCapabilities, selection } =
    useDaw();
  const headingId = useId();
  const searchId = useId();
  const trackId = useId();
  const harshId = useId();
  const avoidHarshId = useId();
  const statusId = useId();
  const applyAllHintId = useId();
  const [classFilter, setClassFilter] = useState<"all" | TightenClass>("all");
  const [trackFilter, setTrackFilter] = useState("");
  const [harshOnly, setHarshOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [avoidHarsh, setAvoidHarsh] = useState(true);

  const canApply = canApplyPass12(projectPath, guestMode, shareCapabilities);
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
      avoidHarsh,
      ids: filtered.map((h) => h.id),
    });
  }, [avoidHarsh, filtered]);
  const eligibleIds = eligibleApplyAllIds(filtered, avoidHarsh);
  const summary = applyAllSummary(filtered.length, eligibleIds.length);
  const applyAllDisabled = !canApply || eligibleIds.length === 0;
  const selectedId = selection?.kind === "pending" ? selection.id : null;

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
        <Field label="Search hits" htmlFor={searchId}>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Reason, snippet, track…"
          />
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
        <Field label="Track" htmlFor={trackId}>
          <select
            id={trackId}
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

      <div className="tighten-bulk">
        <label className="tighten-check" htmlFor={avoidHarshId}>
          <input
            id={avoidHarshId}
            type="checkbox"
            checked={avoidHarsh}
            onChange={(e) => setAvoidHarsh(e.target.checked)}
          />
          Avoid harsh cuts
        </label>
        <CommandButton
          commandId="tighten.applyAllSafe"
          args={{ avoidHarsh, ids: filtered.map((h) => h.id) }}
          disabled={applyAllDisabled}
          aria-describedby={applyAllDisabled ? applyAllHintId : undefined}
        >
          Apply eligible ({eligibleIds.length})
        </CommandButton>
        {applyAllDisabled ? (
          <span id={applyAllHintId} className="sr-only">
            {eligibleIds.length === 0
              ? "Nothing is eligible to apply with the current filters."
              : "Apply is not allowed in this share."}
          </span>
        ) : null}
      </div>

      <p id={statusId} className="tighten-status" aria-live="polite">
        {filtered.length} of {hits.length} hits
        {avoidHarsh
          ? ` · ${eligibleIds.length} eligible (${summary.skipped} harsh skipped)`
          : ` · ${eligibleIds.length} eligible`}
      </p>

      {filtered.length === 0 ? (
        <EmptyState>
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
                            void execute(
                              "tighten.goToHit",
                              { id: hit.id },
                              { skipWhen: true },
                            )
                        : undefined
                    }
                  >
                    <td>
                      {t != null ? (
                        <Button
                          variant="link"
                          onClick={() =>
                            void execute(
                              "tighten.goToHit",
                              { id: hit.id },
                              { skipWhen: true },
                            )
                          }
                        >
                          {formatTimeShort(t)}
                        </Button>
                      ) : (
                        <span>Unmapped</span>
                      )}
                    </td>
                    <td>{trackLabel(hit.track_id)}</td>
                    <td>{hit.tightenClass}</td>
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
                    <td>Pending</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="tighten-row-actions">
                        <CommandButton
                          commandId="tighten.previewHit"
                          args={{ id: hit.id }}
                          variant="link"
                          disabled={!canPreview}
                          aria-label={`Preview ${rowLabel}`}
                        >
                          Preview
                        </CommandButton>
                        <CommandButton
                          commandId="tighten.goToHit"
                          args={{ id: hit.id }}
                          variant="link"
                          disabled={!canGoTo}
                          aria-label={`Go to ${rowLabel}`}
                        >
                          Go to
                        </CommandButton>
                        {canApply ? (
                          <>
                            <CommandButton
                              commandId="tighten.skipHit"
                              args={{ id: hit.id }}
                              variant="link"
                              aria-label={`Skip ${rowLabel}`}
                            >
                              Skip
                            </CommandButton>
                            <CommandButton
                              commandId="tighten.applyHit"
                              args={{ id: hit.id }}
                              variant="link"
                              aria-label={`Apply ${rowLabel}`}
                            >
                              Apply
                            </CommandButton>
                          </>
                        ) : null}
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
