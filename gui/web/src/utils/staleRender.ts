import type { ProjectView } from "../types/project";

export type RenderInvalidationReason =
  | "cut"
  | "clip"
  | "envelope"
  | "fx"
  | "gain"
  | "mute"
  | "other";

export type RenderInvalidationView = {
  id: string;
  track_ids: string[];
  timeline_start: number | null;
  timeline_end: number | null;
  reason: RenderInvalidationReason | (string & {});
  at: string;
};

export type StaleRenderBreakdown = {
  stale: boolean;
  staleTrackIds: string[];
  premixMissing: boolean;
  premixStaleVsStems: boolean;
  reconcileStale: boolean;
  invalidations: RenderInvalidationView[];
  /** Tracks with a whole-track (non-regional) invalidation. */
  wholeTrackIds: string[];
  /** Tracks that only have regional bands (no whole-track cause). */
  regionalOnlyTrackIds: string[];
  /** True when every stale dialogue stem has a whole-track cause (or no invalidations). */
  allStaleAreWholeTrack: boolean;
  /** One-line summary for title / aria. */
  summary: string;
};

const REASON_LABEL: Record<string, string> = {
  cut: "Cut",
  clip: "Clip",
  envelope: "Env",
  fx: "FX",
  gain: "Gain",
  mute: "Mute",
  other: "Stem",
};

export function reasonChipLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
}

function readInvalidations(project: ProjectView): RenderInvalidationView[] {
  const raw = (
    project.render_status as { invalidations?: RenderInvalidationView[] }
  ).invalidations;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (inv) =>
      inv &&
      typeof inv.id === "string" &&
      Array.isArray(inv.track_ids) &&
      inv.track_ids.length > 0,
  );
}

function isRegional(inv: RenderInvalidationView): boolean {
  return (
    inv.timeline_start != null &&
    inv.timeline_end != null &&
    Number.isFinite(inv.timeline_start) &&
    Number.isFinite(inv.timeline_end)
  );
}

function freshBreakdown(): StaleRenderBreakdown {
  return {
    stale: false,
    staleTrackIds: [],
    premixMissing: false,
    premixStaleVsStems: false,
    reconcileStale: false,
    invalidations: [],
    wholeTrackIds: [],
    regionalOnlyTrackIds: [],
    allStaleAreWholeTrack: false,
    summary: "Fresh",
  };
}

/** Derive what is out of date from project view + track stem_is_fresh. */
export function staleRenderBreakdown(
  project: ProjectView | null | undefined,
): StaleRenderBreakdown {
  if (!project) {
    return freshBreakdown();
  }
  // A project that has never been rendered has nothing to be stale relative
  // to: no tracks, no premix, and no invalidation journal entries. Without
  // this carve-out a brand-new project reports "Stale render".
  const neverRendered =
    project.tracks.length === 0 &&
    project.render_status.premix.exists !== true &&
    readInvalidations(project).length === 0;
  if (neverRendered) {
    return freshBreakdown();
  }
  const rs = project.render_status;
  const tracksRs = (
    rs as {
      tracks?: Record<
        string,
        { stem_is_fresh?: boolean | null; stem_exists?: boolean }
      >;
    }
  ).tracks;
  const premix = rs.premix as {
    exists?: boolean;
    stale_vs_stems?: boolean;
  };

  const staleTrackIds: string[] = [];
  for (const t of project.tracks) {
    const info = tracksRs?.[t.id];
    const fresh = t.stem_is_fresh ?? (info ? info.stem_is_fresh : null);
    const exists = info?.stem_exists;
    if (fresh === false || exists === false) {
      staleTrackIds.push(t.id);
    }
  }

  const invalidations = readInvalidations(project);
  const wholeTrackIds = new Set<string>();
  const regionalTrackIds = new Set<string>();
  for (const inv of invalidations) {
    if (isRegional(inv)) {
      for (const tid of inv.track_ids) {
        regionalTrackIds.add(tid);
      }
    } else {
      for (const tid of inv.track_ids) {
        wholeTrackIds.add(tid);
      }
    }
  }

  const regionalOnlyTrackIds = [...regionalTrackIds].filter(
    (tid) => !wholeTrackIds.has(tid),
  );

  const premixMissing = premix?.exists === false;
  const premixStaleVsStems = premix?.stale_vs_stems === true;
  const reconcileStale = Boolean(rs.reconciliation?.stale);
  // Freshness flags (needs_rerender / stem hashes / premix) are authoritative.
  // Invalidations are diagnostic only — do not mark stale from the journal alone.
  const stale =
    Boolean(rs.needs_rerender) ||
    reconcileStale ||
    staleTrackIds.length > 0 ||
    premixMissing ||
    premixStaleVsStems;

  const allStaleAreWholeTrack =
    staleTrackIds.length > 0 &&
    staleTrackIds.every(
      (tid) => wholeTrackIds.has(tid) || !regionalTrackIds.has(tid),
    ) &&
    regionalOnlyTrackIds.length === 0;

  const parts: string[] = [];
  if (stale && invalidations.length) {
    const reasons = [...new Set(invalidations.map((i) => i.reason))];
    const regionalCount = invalidations.filter(isRegional).length;
    if (regionalCount) {
      parts.push(`${regionalCount} region${regionalCount === 1 ? "" : "s"}`);
    }
    const wholeReasons = reasons.filter((r) =>
      invalidations.some((i) => i.reason === r && !isRegional(i)),
    );
    if (wholeReasons.length) {
      parts.push(wholeReasons.map(reasonChipLabel).join(", "));
    }
  } else if (stale && staleTrackIds.length) {
    parts.push(`Stale stems: ${staleTrackIds.join(", ")}`);
  }
  if (premixMissing) {
    parts.push("No mix preview");
  } else if (premixStaleVsStems) {
    parts.push("Mix preview behind stems");
  }
  if (reconcileStale) {
    parts.push("Transcript out of date");
  }

  return {
    stale,
    staleTrackIds,
    premixMissing,
    premixStaleVsStems,
    reconcileStale,
    invalidations,
    wholeTrackIds: [...wholeTrackIds],
    regionalOnlyTrackIds,
    allStaleAreWholeTrack,
    summary: parts.length ? parts.join(" · ") : "Fresh",
  };
}

export function invalidationsForTrack(
  breakdown: StaleRenderBreakdown,
  trackId: string,
): RenderInvalidationView[] {
  return breakdown.invalidations.filter((inv) =>
    inv.track_ids.includes(trackId),
  );
}

export function wholeTrackReasonsForTrack(
  breakdown: StaleRenderBreakdown,
  trackId: string,
): string[] {
  const reasons = new Set<string>();
  for (const inv of invalidationsForTrack(breakdown, trackId)) {
    if (!isRegional(inv)) {
      reasons.add(inv.reason);
    }
  }
  if (
    reasons.size === 0 &&
    breakdown.staleTrackIds.includes(trackId) &&
    breakdown.invalidations.length === 0
  ) {
    reasons.add("other");
  }
  return [...reasons];
}

export { isRegional as isRegionalInvalidation };
