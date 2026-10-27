import { isShareProjectKey } from "../shareMode";
import { ApiError } from "../utils/apiError";
import { apiFetch } from "./http";

/**
 * The Review card's A and B each play 3 s before the change through 3 s after
 * it (design-system #21). `GET /api/pending-preview` takes 0 to 10.
 */
export const REVIEW_AUDITION_PAD_SEC = 3;
export const MAX_AUDITION_PAD_SEC = 10;

/** "A" is the original (`mode=current`), "B" the edited result (`mode=suggested`). */
export type AuditionSide = "A" | "B";

const SIDE_MODE: Record<AuditionSide, "current" | "suggested"> = {
  A: "current",
  B: "suggested",
};

/**
 * Where a rendered audition file sits, in seconds, from the `X-Preview-*`
 * headers. `startSec` / `endSec` bound the file on its own timeline: the
 * current timeline for A, the timeline after the edit for B (the cut span is
 * gone, so the join sits at `editStartSec`). `editStartSec` / `editEndSec` are
 * the edit on the current timeline, so A's playhead for the edit is
 * `editStartSec - startSec` into the file. File times are timeline seconds
 * minus `startSec`.
 */
export type PendingAuditionSpan = {
  editId: string;
  padSec: number;
  startSec: number;
  endSec: number;
  editStartSec: number;
  editEndSec: number;
};

export type PendingAuditionFile = {
  side: AuditionSide;
  blob: Blob;
  span: PendingAuditionSpan;
};

function header(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null) throw new Error(`Invalid preview response: ${name}`);
  return value;
}

function seconds(headers: Headers, name: string): number {
  const value = Number(header(headers, name));
  if (!Number.isFinite(value))
    throw new Error(`Invalid preview response: ${name}`);
  return value;
}

export function parsePendingAuditionSpan(
  headers: Headers,
): PendingAuditionSpan {
  return {
    editId: header(headers, "X-Preview-Edit-Id"),
    padSec: seconds(headers, "X-Preview-Pad-Sec"),
    startSec: seconds(headers, "X-Preview-Start-Sec"),
    endSec: seconds(headers, "X-Preview-End-Sec"),
    editStartSec: seconds(headers, "X-Preview-Edit-Start-Sec"),
    editEndSec: seconds(headers, "X-Preview-Edit-End-Sec"),
  };
}

function checkedPad(padSec: number): number {
  if (!Number.isFinite(padSec) || padSec < 0 || padSec > MAX_AUDITION_PAD_SEC)
    throw new RangeError(
      `Audition padding must be 0 to ${MAX_AUDITION_PAD_SEC} seconds`,
    );
  return padSec;
}

function query(
  editId: string,
  mode: string,
  padSec: number,
  projectPath?: string,
): string {
  const params = new URLSearchParams();
  if (projectPath !== undefined) params.set("path", projectPath);
  params.set("edit_id", editId);
  params.set("mode", mode);
  params.set("pad_sec", String(padSec));
  return params.toString();
}

/**
 * Fetch one side of a pending edit's audition: the original (A) or the edited
 * result (B) as its own WAV, `padSec` of audio either side of the edit, plus
 * where the file sits so the page can place the playheads. Suggested (B) is the
 * edit approved on a snapshot, so it matches what Approve ships and what the
 * premix will hold; absolute loudness is not the exported file's, because the
 * master stage's loudness target and limiter are not applied. A and B are
 * comparable to each other, so never claim they equal the export's loudness.
 *
 * Throws `ApiError` (with the server's code, e.g. `pending_preview_unavailable`
 * when B does not exist for a split) for a refusal.
 */
export async function fetchPendingAuditionSide(
  projectPath: string,
  editId: string,
  side: AuditionSide,
  options: { padSec?: number; signal?: AbortSignal } = {},
): Promise<PendingAuditionFile> {
  const padSec = checkedPad(options.padSec ?? REVIEW_AUDITION_PAD_SEC);
  const mode = SIDE_MODE[side];
  const response = await apiFetch(
    projectPath,
    {
      host: `/api/pending-preview?${query(editId, mode, padSec, projectPath)}`,
      guest: `/daw/pending-preview?${query(editId, mode, padSec)}`,
    },
    { signal: options.signal },
  );
  let span: PendingAuditionSpan;
  try {
    span = parsePendingAuditionSpan(response.headers);
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : "Invalid preview response",
      null,
      response.status,
    );
  }
  return { side, blob: await response.blob(), span };
}

/**
 * Render both sides at `padSec` ahead of the first A or B press (a window is
 * cached per pad, so warm the pad the card will play). Host only; a guest has
 * nothing to warm and resolves true. Resolves false when the host refused or a side failed.
 */
export async function warmPendingAudition(
  projectPath: string,
  editId: string,
  padSec: number = REVIEW_AUDITION_PAD_SEC,
): Promise<boolean> {
  if (isShareProjectKey(projectPath)) return true;
  const params = new URLSearchParams({
    path: projectPath,
    edit_id: editId,
    pad_sec: String(checkedPad(padSec)),
  });
  try {
    const response = await apiFetch(
      projectPath,
      { host: `/api/pending-preview/warm?${params}` },
      { method: "POST" },
    );
    const { sides = {} } = (await response.json()) as {
      sides?: Record<string, string>;
    };
    return !Object.values(sides).includes("failed");
  } catch {
    return false;
  }
}
