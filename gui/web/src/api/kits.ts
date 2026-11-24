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
