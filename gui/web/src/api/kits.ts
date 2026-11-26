import type {
  KitSaveEntry as GeneratedSaveEntry,
  KitSaveRequest as GeneratedSaveRequest,
} from "../types/project.generated";
import { ApiError } from "../utils/apiError";
import { documentClientId } from "../utils/documentClient";
import { cancelStaged, commitStaged, stageBundle } from "./bundleImport";
import { apiFetch, HOST_KEY } from "./http";
import type { SegmentKind } from "./segments";

export type KitOfferReason =
  | "offer"
  | "no_clips"
  | "already_has_segments"
  | "no_kits"
  | "no_usable_kits";

export interface KitOfferEntry {
  segment_id: string;
  version: number;
  at: "start" | "end" | number;
  note: string | null;
}

export interface KitOfferKit {
  id: string;
  name: string;
  version: number;
  entries: KitOfferEntry[];
}

export interface KitOfferUnusable {
  id: string;
  name: string;
  version: number;
  missing: number;
  problem: string;
}

export interface KitOffer {
  offer: boolean;
  reason: KitOfferReason;
  kits: KitOfferKit[];
  unusable: KitOfferUnusable[];
}

/** Whether the episode at `path` should be offered a show kit, and which kits it can offer. */
export async function loadKitOffer(
  path: string,
  signal?: AbortSignal,
): Promise<KitOffer> {
  const res = await apiFetch(
    HOST_KEY,
    { host: `/api/kits/offer?path=${encodeURIComponent(path)}` },
    { signal },
  );
  return (await res.json()) as KitOffer;
}

/** One applied entry. */
export interface KitApplyEntry {
  position: number;
  /** The history head this entry left, read under the document lock. */
  history_head_id: string | null;
  [key: string]: unknown;
}

/** The report of a real apply: `applyKit` never asks for a dry run, which omits `undo_steps` and the entry heads. */
export interface KitApplyReport {
  kit_id: string;
  kit_version: number;
  timeline_duration_before_sec: number;
  timeline_duration_after_sec: number;
  dry_run: boolean;
  entries: KitApplyEntry[];
  /** One History step per entry. */
  undo_steps: number;
}

/**
 * Applies the offered kit version to the episode at `path`. The server refuses
 * (`kit_not_offered`, `kit_changed`) when the offer went stale since it was read.
 */
export async function applyKit(
  path: string,
  kit: { id: string; version: number },
): Promise<KitApplyReport> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/kits/apply" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        kit_id: kit.id,
        kit_version: kit.version,
        client_id: documentClientId(),
      }),
    },
  );
  return (await res.json()) as KitApplyReport;
}

/** A kit in the library: its newest version, and whether every entry still resolves. */
export interface KitRow {
  id: string;
  name: string;
  version: number;
  versions: number[];
  entries: number;
  missing: number;
  usable: boolean;
  /** The first entry that fails, in the server's words; null when the kit is usable. */
  problem: string | null;
}

/** A kit the library cannot read: no name or entries, only what went wrong. */
export interface DamagedKitRow {
  id: string;
  damaged: true;
  version: number;
  usable: false;
  problem: string;
  code: string;
}

export type KitListRow = KitRow | DamagedKitRow;

export function isDamagedKit(row: KitListRow): row is DamagedKitRow {
  return "damaged" in row && row.damaged === true;
}

/** Every kit in the library, healthy rows first and unreadable ones last. */
export async function loadKits(signal?: AbortSignal): Promise<KitListRow[]> {
  const res = await apiFetch(HOST_KEY, { host: "/api/kits" }, { signal });
  return (await res.json()) as KitListRow[];
}

/** One segment of a kit being saved. A version is left out so the entry follows the newest. */
export type KitSaveEntry = Omit<GeneratedSaveEntry, "at"> & {
  at: "start" | "end" | number;
};

export type KitSaveRequest = Omit<GeneratedSaveRequest, "entries"> & {
  entries: KitSaveEntry[];
};

export interface KitSaveResult {
  status: KitImportOutcome;
  id: string;
  version: number;
}

/** Codes a kit save is refused with; the first three are the sheet's own mistakes to fix. */
export const KIT_SAVE_REFUSALS = [
  "kit_name_invalid",
  "kit_invalid",
  "kit_segment_missing",
  "kit_busy",
  "kit_write_failed",
] as const;

export type KitSaveRefusal = (typeof KIT_SAVE_REFUSALS)[number];

export function kitSaveRefusal(error: unknown): KitSaveRefusal | null {
  if (!(error instanceof ApiError)) return null;
  return KIT_SAVE_REFUSALS.find((code) => code === error.code) ?? null;
}

/**
 * Saves a kit: a new one, the next version of the kit with that name, or nothing
 * (`unchanged`). The reply is the outcome, not the row; read the list again.
 */
export async function saveKit(
  request: KitSaveRequest,
  signal?: AbortSignal,
): Promise<KitSaveResult> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/kits" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );
  return (await res.json()) as KitSaveResult;
}

export interface KitFileDownload {
  blob: Blob;
  filename: string;
}

const DISPOSITION_NAME = /filename="([A-Za-z0-9._-]+)"/;

/** The newest version as a `.sharecutkit` file, fetched whole so a phone can share it. */
export async function downloadKitFile(
  id: string,
  signal?: AbortSignal,
): Promise<KitFileDownload> {
  const res = await apiFetch(
    HOST_KEY,
    { host: `/api/kits/${encodeURIComponent(id)}/export` },
    { signal },
  );
  const named = DISPOSITION_NAME.exec(
    res.headers.get("content-disposition") ?? "",
  );
  return {
    blob: await res.blob(),
    filename: named?.[1] ?? `${id}.sharecutkit`,
  };
}

export type KitImportOutcome = "added" | "new_version" | "unchanged";

/** One segment of a waiting kit file, in the order the kit applies it. */
export interface KitImportEntry {
  position: number;
  name: string;
  kind: SegmentKind;
  duration_sec: number;
  at: "start" | "end" | number;
  note: string | null;
  /** What adding this entry's segment would do to the segment library. */
  outcome: KitImportOutcome;
  version: number;
}

/** A checked kit upload that waits for Add: what it is and what adding it would do. */
export interface KitImportPreview {
  token: string;
  name: string;
  kit_id: string;
  outcome: KitImportOutcome;
  version: number;
  entry_count: number;
  counts: Record<KitImportOutcome, number>;
  entries: KitImportEntry[];
}

export interface KitImportStatus {
  status: KitImportOutcome | "skipped";
  id: string;
  version: number;
}

export interface KitImportResult {
  kit: KitImportStatus;
  segments: KitImportStatus[];
}

/** The body of a commit that failed after some segments landed. */
export interface KitImportIncompleteBody {
  detail: string;
  segments_added: KitImportStatus[];
  segments_total: number;
}

/** Codes after which the server keeps the staged file, so adding again is safe. */
export const KIT_IMPORT_RETRY_CODES: ReadonlySet<string | null> = new Set([
  "kit_busy",
  "kit_no_room",
  "kit_write_failed",
]);

export const KIT_TOO_LARGE_MESSAGE = "That file is too large to import here.";

const KIT_IMPORT = "/api/kits/import";

/**
 * A reverse proxy or tunnel in front of the host may refuse a large body with its own 413,
 * which carries no kit code. A dropped connection is not this: it says so and can be retried.
 */
function isTooLarge(failure: unknown): boolean {
  if (!(failure instanceof ApiError)) return false;
  if (failure.code === "kit_upload_too_large") return false;
  return failure.code === "payload_too_large" || failure.status === 413;
}

/** Sends the file as the raw body (no FormData); nothing is added to the libraries. */
export async function previewKitImport(
  file: File,
  signal?: AbortSignal,
): Promise<KitImportPreview> {
  try {
    return await stageBundle<KitImportPreview>(KIT_IMPORT, file, signal);
  } catch (failure) {
    if (isTooLarge(failure)) {
      const known = failure as ApiError;
      throw new ApiError(
        KIT_TOO_LARGE_MESSAGE,
        known.code,
        known.status,
        null,
        known.body,
      );
    }
    throw failure;
  }
}

export function commitKitImport(
  token: string,
  signal?: AbortSignal,
): Promise<KitImportResult> {
  return commitStaged<KitImportResult>(KIT_IMPORT, token, signal);
}

export function cancelKitImport(token: string): Promise<void> {
  return cancelStaged(KIT_IMPORT, token);
}

/**
 * What a refused commit says about segments that landed before it failed: how many this
 * call added and how many the file holds. Null when the refusal carries no such body.
 */
export function partialImport(
  failure: unknown,
): { added: number; total: number } | null {
  if (!(failure instanceof ApiError)) return null;
  const body = failure.body as Partial<KitImportIncompleteBody> | null;
  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray(body.segments_added) ||
    typeof body.segments_total !== "number"
  )
    return null;
  return { added: body.segments_added.length, total: body.segments_total };
}
