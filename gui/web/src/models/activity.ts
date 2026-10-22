import type { ModelFailure, ModelState, ModelView } from "./types";

/** Why Download is unavailable while the server's one download slot is taken. */
export const ANOTHER_DOWNLOAD_REASON = "Another download is running";

export type ModelActivity = {
  /** This model is queued or downloading: show it busy, not another model. */
  working: boolean;
  downloading: Extract<ModelState, { kind: "downloading" }> | null;
  failure: ModelFailure | null;
  /** Set when a different download holds the slot. */
  blockedReason: string | undefined;
};

/** What a feature surface needs to paint one model's download: its own progress or failure, or a block. */
export function modelActivity(
  row: ModelView | null,
  busy: boolean,
): ModelActivity {
  const kind = row?.state.kind;
  const working = kind === "downloading" || kind === "queued";
  return {
    working,
    downloading: row?.state.kind === "downloading" ? row.state : null,
    failure: row?.state.kind === "failed" ? row.state.failure : null,
    blockedReason: busy && !working ? ANOTHER_DOWNLOAD_REASON : undefined,
  };
}
