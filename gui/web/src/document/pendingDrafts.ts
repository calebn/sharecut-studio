import { DocumentCommand } from "../types/documentCommands.generated";
import type { AutomationPoint, ProjectView, TrackView } from "../types/project";
import { withVolumeEnvelopePoints } from "../utils/envelopes";
import { documentAuthority } from "./authorityState";
import {
  type ClipMoveItem,
  patchClipFade,
  patchClipsMove,
  patchTrackMeta,
  patchTrackMix,
  patchTracksOrder,
} from "./projectPatch";

type Draft =
  | { kind: "move"; clips: ClipMoveItem[] }
  | { kind: "fade"; clipId: string; fadeInMs: number; fadeOutMs: number }
  /** A held control's local preview, a function of the latest project (not a copy of one). */
  | {
      kind: "preview";
      owner: symbol;
      apply: (project: ProjectView) => ProjectView;
    }
  | { kind: "order"; track: string; index: number }
  | {
      kind: "meta";
      track: string;
      fields: Partial<Pick<TrackView, "label" | "role" | "speaker">>;
    }
  | {
      kind: "mix";
      track: string;
      fields: Partial<Pick<TrackView, "muted" | "fader_db">>;
    }
  | { kind: "envelope"; track: string; points: AutomationPoint[] };
type Pending = { commandId: string; draft: Draft };
const drafts = new Map<string, Pending>();
const heldAcks = new Map<string, number>();
let generation = -1;
function current(): Map<string, Pending> {
  if (generation !== documentAuthority.generation) {
    drafts.clear();
    heldAcks.clear();
    generation = documentAuthority.generation;
  }
  return drafts;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function hasDocumentDrafts(): boolean {
  return current().size > 0;
}
export function beginDocumentDraft(
  commandId: string,
  type: string,
  payload: Record<string, unknown>,
  replaying = false,
): void {
  heldAcks.delete(commandId);
  const entries: [string, Draft][] = [];
  const track = payload.track_id;
  if (type === DocumentCommand.MoveClips && Array.isArray(payload.clips)) {
    const clips: ClipMoveItem[] = [];
    if (payload.clips.length > 10_000)
      throw new Error("Too many pending clip moves");
    for (const raw of payload.clips) {
      const value = record(raw);
      if (
        !value ||
        typeof value.clip_id !== "string" ||
        typeof value.track_id !== "string" ||
        typeof value.timeline_start !== "number" ||
        !Number.isFinite(value.timeline_start)
      )
        return;
      clips.push({
        clip_id: value.clip_id,
        track_id: value.track_id,
        timeline_start: value.timeline_start,
      });
    }
    entries.push([commandId, { kind: "move", clips }]);
  } else if (
    type === DocumentCommand.SetClipFade &&
    typeof payload.clip_id === "string" &&
    typeof payload.fade_in_ms === "number" &&
    Number.isFinite(payload.fade_in_ms) &&
    typeof payload.fade_out_ms === "number" &&
    Number.isFinite(payload.fade_out_ms)
  ) {
    entries.push([
      `fade:${payload.clip_id}`,
      {
        kind: "fade",
        clipId: payload.clip_id,
        fadeInMs: payload.fade_in_ms,
        fadeOutMs: payload.fade_out_ms,
      },
    ]);
  } else if (typeof track === "string") {
    if (
      type === DocumentCommand.ReorderTrack &&
      typeof payload.index === "number" &&
      Number.isSafeInteger(payload.index) &&
      payload.index >= 0
    )
      entries.push([commandId, { kind: "order", track, index: payload.index }]);
    if (type === DocumentCommand.SetTrackMeta)
      for (const key of ["label", "role", "speaker"] as const) {
        const value = payload[key];
        if (typeof value === "string" || (key === "speaker" && value === null))
          entries.push([
            `meta:${track}:${key}`,
            { kind: "meta", track, fields: { [key]: value } },
          ]);
      }
    if (
      type === DocumentCommand.SetTrackFader &&
      typeof payload.fader_db === "number" &&
      Number.isFinite(payload.fader_db)
    )
      entries.push([
        `mix:${track}:fader`,
        { kind: "mix", track, fields: { fader_db: payload.fader_db } },
      ]);
    if (
      type === DocumentCommand.SetTrackMute &&
      typeof payload.muted === "boolean"
    )
      entries.push([
        `mix:${track}:muted`,
        { kind: "mix", track, fields: { muted: payload.muted } },
      ]);
    if (
      type === DocumentCommand.SetEnvelope &&
      (payload.parameter === undefined || payload.parameter === "volume") &&
      Array.isArray(payload.points)
    ) {
      const points: AutomationPoint[] = [];
      if (payload.points.length > 10_000)
        throw new Error("Too many pending envelope points");
      for (const raw of payload.points) {
        const point = record(raw);
        if (
          !point ||
          typeof point.id !== "string" ||
          typeof point.time !== "number" ||
          !Number.isFinite(point.time) ||
          typeof point.value !== "number" ||
          !Number.isFinite(point.value)
        )
          return;
        points.push({ id: point.id, time: point.time, value: point.value });
      }
      entries.push([`envelope:${track}`, { kind: "envelope", track, points }]);
    }
  }
  const pending = current();
  if (pending.size + entries.filter(([key]) => !pending.has(key)).length > 256)
    throw new Error(
      "Wait for pending edits to finish before editing more tracks",
    );
  const candidate = new Map(pending);
  for (const [key, draft] of entries) {
    if (
      replaying &&
      candidate.has(key) &&
      candidate.get(key)?.commandId !== commandId
    )
      continue;
    candidate.set(key, { commandId, draft });
  }
  let items = 0;
  for (const { draft } of candidate.values()) {
    items +=
      draft.kind === "move"
        ? draft.clips.length
        : draft.kind === "envelope"
          ? draft.points.length
          : 1;
    if (items > 20_000)
      throw new Error(
        "Wait for pending edits to finish before editing more items",
      );
  }
  for (const [key, value] of candidate) pending.set(key, value);
}
/** Show `apply` over the latest project until `clearPreviewDraft`; the caller redisplays. */
export function setPreviewDraft(
  key: string,
  owner: symbol,
  apply: (project: ProjectView) => ProjectView,
): void {
  const pending = current();
  const id = `preview:${key}`;
  if (!pending.has(id) && pending.size >= 256)
    throw new Error(
      "Wait for pending edits to finish before editing more tracks",
    );
  pending.set(id, { commandId: id, draft: { kind: "preview", owner, apply } });
}
/** True when `owner` held the preview, so the caller knows to redisplay. */
export function clearPreviewDraft(key: string, owner: symbol): boolean {
  const id = `preview:${key}`;
  const held = current().get(id)?.draft;
  if (held?.kind !== "preview" || held.owner !== owner) return false;
  return current().delete(id);
}
export function finishDocumentDraft(commandId: string): void {
  if (heldAcks.has(commandId)) return;
  for (const [key, value] of current())
    if (value.commandId === commandId) drafts.delete(key);
}
export function holdDocumentDraftUntil(commandId: string, seq: number): void {
  current();
  heldAcks.set(commandId, seq);
}
export function releaseHeldDrafts(adoptedSeq: number): void {
  current();
  for (const [commandId, seq] of heldAcks) {
    if (seq > adoptedSeq) continue;
    heldAcks.delete(commandId);
    finishDocumentDraft(commandId);
  }
}
/** Previews go last: a preview that keeps its place in the table must still sit over a newer command draft. */
export function overlayDocumentDrafts(
  project: ProjectView,
  withPreviews = true,
): ProjectView {
  let result = project;
  const drafts = [...current().values()].map(({ draft }) => draft);
  const ordered = withPreviews
    ? [
        ...drafts.filter((d) => d.kind !== "preview"),
        ...drafts.filter((d) => d.kind === "preview"),
      ]
    : drafts.filter((d) => d.kind !== "preview");
  for (const draft of ordered) {
    switch (draft.kind) {
      case "move":
        result = patchClipsMove(result, draft.clips);
        break;
      case "fade":
        result = patchClipFade(
          result,
          draft.clipId,
          draft.fadeInMs,
          draft.fadeOutMs,
        );
        break;
      case "preview":
        result = draft.apply(result);
        break;
      case "order":
        result = patchTracksOrder(result, draft.track, draft.index);
        break;
      case "meta":
        result = patchTrackMeta(result, draft.track, draft.fields);
        break;
      case "mix":
        result = patchTrackMix(result, draft.track, draft.fields);
        break;
      case "envelope":
        result = {
          ...result,
          envelopes: withVolumeEnvelopePoints(
            result.envelopes,
            draft.track,
            draft.points,
          ),
        };
        break;
    }
  }
  return result;
}
