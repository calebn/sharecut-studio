import type {
  BleedAttenuationInspection,
  BleedAttenuationRegion,
  BleedAttenuationSpan,
} from "../edit/bleedAttenuation";
import { isShareProjectKey } from "../shareMode";
import type { HistoryEntryId } from "../types/project";
import { replyHistoryHead, submitDocumentCommand } from "./documentEdits";
import { apiFetch } from "./http";

declare const restoreTargetBrand: unique symbol;

export type OpaqueBleedRestoreTarget = Readonly<Record<string, unknown>> & {
  readonly [restoreTargetBrand]: true;
};

export type ClipBleedRegion = BleedAttenuationRegion<OpaqueBleedRestoreTarget> &
  Readonly<{ actualSourceSpan: BleedAttenuationSpan }>;

export type ClipBleedInspection = Omit<
  BleedAttenuationInspection<OpaqueBleedRestoreTarget>,
  "regions"
> &
  Readonly<{
    fadeSec: number | null;
    reduction: "mute" | "attenuate" | null;
    attenuationDb: number | null;
    regions: readonly ClipBleedRegion[];
  }>;

export type ClipBleedRequest = Readonly<{
  projectPath: string;
  clipId: string;
  trackId: string;
  clipLabel: string;
}>;

export type RestoreOutcome =
  | { status: "queued" }
  | { status: "acknowledged"; historyHead: HistoryEntryId }
  | { status: "noop" }
  | { status: "unconfirmed" };

function hostOnly(projectPath: string): void {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Only the project host can inspect or restore this audio.");
  }
}

function invalidInspection(): never {
  throw new Error("Invalid automatic reduction response. Refresh regions.");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidInspection();
  }
  return value as Record<string, unknown>;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    return invalidInspection();
  }
  return value;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalidInspection();
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : finiteNumber(value);
}

function span(value: unknown, source: boolean): BleedAttenuationSpan {
  const row = record(value);
  const start = finiteNumber(source ? row.start_s : row.start);
  const end = finiteNumber(source ? row.end_s : row.end);
  if (start < 0 || end <= start) return invalidInspection();
  return { start, end };
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalidInspection();
  return value;
}

function parseRegion(
  value: unknown,
  request: ClipBleedRequest,
): ClipBleedRegion {
  const row = record(value);
  const kind = oneOf(row.kind, ["late_gate", "bleed_mute:off_speaker"]);
  const sourceSpan = span(row.source, true);
  const timelineSpan = span(row.timeline, false);
  const actualSourceSpan = span(row.actual_source, true);
  const state = oneOf(row.restore_state, ["available", "saved", "unavailable"]);
  let restore: ClipBleedRegion["restore"];
  if (state === "available") {
    const target = record(row.target);
    const clip = record(target.clip);
    const region = span(target.region, true);
    oneOf(target.occurrence_kind, ["explicit", "implicit"]);
    if (target.mapping_revision !== undefined) {
      oneOf(target.mapping_revision, ["editorial-source-v1"]);
    }
    if (
      typeof target.media_seal !== "string" ||
      typeof target.dependencies_digest !== "string" ||
      typeof target.plan_digest !== "string" ||
      typeof target.expected_head_id !== "string" ||
      target.expected_head_id.length === 0 ||
      typeof target.source_sha256 !== "string" ||
      target.source_sha256.length !== 64 ||
      !/^[0-9a-f]{64}$/.test(target.source_sha256)
    ) {
      return invalidInspection();
    }
    finiteNumber(clip.source_start);
    finiteNumber(clip.source_end);
    finiteNumber(clip.timeline_start);
    if (clip.join_in_mode !== undefined) {
      oneOf(clip.join_in_mode, ["fade", "crossfade", "cut"]);
    }
    if (
      target.track_id !== request.trackId ||
      clip.id !== request.clipId ||
      clip.track_id !== request.trackId ||
      target.kind !== kind ||
      region.start !== sourceSpan.start ||
      region.end !== sourceSpan.end
    ) {
      return invalidInspection();
    }
    restore = {
      state,
      target: target as OpaqueBleedRestoreTarget,
      sourceSpan,
    };
  } else {
    if (row.target !== null) return invalidInspection();
    restore =
      state === "saved"
        ? { state }
        : {
            state,
            reason: "This region could not be checked. Refresh regions.",
          };
  }
  return {
    trackId: request.trackId,
    occurrenceId: request.clipId,
    kind,
    sourceSpan,
    timelineSpan,
    actualSourceSpan,
    restore,
  };
}

function parseInspection(
  value: unknown,
  request: ClipBleedRequest,
): ClipBleedInspection {
  const row = record(value);
  if (row.clip_id !== request.clipId || row.track_id !== request.trackId) {
    return invalidInspection();
  }
  const planReasons = array(row.reasons).map((reason) => {
    if (typeof reason !== "string") return invalidInspection();
    return reason;
  });
  const fadeSec = nullableNumber(row.fade_sec);
  if (fadeSec !== null && fadeSec < 0) return invalidInspection();
  return {
    clipLabel: request.clipLabel,
    planState: oneOf(row.plan_state, [
      "disabled",
      "ready",
      "unavailable_evidence",
    ]),
    planReasons,
    artifactState: oneOf(row.artifact_state, ["missing", "stale", "current"]),
    restoreState: oneOf(row.restore_state, [
      "none",
      "current",
      "changed_content",
      "unverified",
    ]),
    fadeSec,
    reduction:
      row.reduction === null
        ? null
        : oneOf(row.reduction, ["mute", "attenuate"]),
    attenuationDb: nullableNumber(row.attenuation_db),
    savedSourceSpans: array(row.saved_source_regions).map((value) =>
      span(value, true),
    ),
    regions: array(row.regions).map((value) => parseRegion(value, request)),
  };
}

export async function loadClipBleedInspection(
  request: ClipBleedRequest,
  signal: AbortSignal,
): Promise<ClipBleedInspection> {
  hostOnly(request.projectPath);
  const query = new URLSearchParams({
    path: request.projectPath,
    track_id: request.trackId,
  });
  const response = await apiFetch(
    "",
    { host: `/api/clips/${encodeURIComponent(request.clipId)}/bleed?${query}` },
    { signal },
  );
  const value: unknown = await response.json();
  return parseInspection(value, request);
}

export async function restoreClipBleed(
  projectPath: string,
  target: OpaqueBleedRestoreTarget,
): Promise<RestoreOutcome> {
  hostOnly(projectPath);
  const result = await submitDocumentCommand(projectPath, "RestoreClipBleed", {
    target,
  });
  if (result.queued === true) return { status: "queued" };
  const historyHead = replyHistoryHead(result);
  if (historyHead !== null) return { status: "acknowledged", historyHead };
  return { status: result.history_head_id === null ? "noop" : "unconfirmed" };
}
