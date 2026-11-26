import { documentClientId } from "../utils/documentClient";
import { apiFetch, HOST_KEY } from "./http";

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
