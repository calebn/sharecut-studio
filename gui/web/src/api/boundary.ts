import type { EditMode, TrimEdge } from "../edit/clipEdgePreview";
import { withSessionTokenQuery } from "../sessionAuth";
import {
  isShareProjectKey,
  reviewApiBase,
  shareTokenFromKey,
} from "../shareMode";
import { readApiError } from "../utils/apiError";
import { hostFetch } from "./documentTransport";

export type BoundaryTarget =
  | { kind: "roll"; left_clip_id: string; right_clip_id: string }
  | { kind: "trim"; clip_id: string; edge: TrimEdge; mode?: EditMode };

export type BoundaryGeometryClip = {
  id: string;
  source_start: number;
  source_end: number;
  timeline_start: number;
  source_id: string | null;
};

export type BoundaryEdit =
  | (Extract<BoundaryTarget, { kind: "roll" }> & { delta_sec: number })
  | (Extract<BoundaryTarget, { kind: "trim" }> & {
      source_sec: number;
      mode: "ripple";
    });

export type BoundaryContext = {
  target: BoundaryTarget;
  token: string;
  track_id: string;
  geometry: BoundaryGeometryClip[];
  current: { source_sec: number; timeline_sec: number };
  limits: {
    min: number;
    max: number;
    fine_step_sec: 0.001;
    regular_step_sec: 0.01;
  };
};

export type BoundaryAudioWindow = {
  url: string;
  window_start_sec: number;
  window_end_sec: number;
  duration_sec: number;
  seam_offset_sec: number;
};

export type BoundaryAudition = {
  token: string;
  actual_edit: BoundaryEdit;
  current: BoundaryAudioWindow;
  proposed: BoundaryAudioWindow;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Invalid boundary response: ${label}`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`Invalid boundary response: ${label}`);
  return value;
}

function parseTarget(value: unknown): BoundaryTarget {
  if (!isRecord(value)) throw new Error("Invalid boundary response: target");
  if (value.kind === "roll") {
    return {
      kind: "roll",
      left_clip_id: text(value.left_clip_id, "target.left_clip_id"),
      right_clip_id: text(value.right_clip_id, "target.right_clip_id"),
    };
  }
  if (value.kind === "trim" && (value.edge === "in" || value.edge === "out")) {
    return {
      kind: "trim",
      clip_id: text(value.clip_id, "target.clip_id"),
      edge: value.edge,
    };
  }
  throw new Error("Invalid boundary response: target kind");
}

function sameTarget(left: BoundaryTarget, right: BoundaryTarget): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "roll" && right.kind === "roll"
    ? left.left_clip_id === right.left_clip_id &&
        left.right_clip_id === right.right_clip_id
    : left.kind === "trim" && right.kind === "trim"
      ? left.clip_id === right.clip_id && left.edge === right.edge
      : false;
}

function parseGeometry(value: unknown): BoundaryGeometryClip[] {
  if (!Array.isArray(value))
    throw new Error("Invalid boundary response: geometry");
  return value.map((item, index) => {
    if (!isRecord(item))
      throw new Error(`Invalid boundary response: geometry[${index}]`);
    if (item.source_id !== null && typeof item.source_id !== "string")
      throw new Error(
        `Invalid boundary response: geometry[${index}].source_id`,
      );
    return {
      id: text(item.id, `geometry[${index}].id`),
      source_start: finite(
        item.source_start,
        `geometry[${index}].source_start`,
      ),
      source_end: finite(item.source_end, `geometry[${index}].source_end`),
      timeline_start: finite(
        item.timeline_start,
        `geometry[${index}].timeline_start`,
      ),
      source_id: item.source_id,
    };
  });
}

function parseWindow(value: unknown, label: string): BoundaryAudioWindow {
  if (!isRecord(value)) throw new Error(`Invalid boundary response: ${label}`);
  const url = text(value.url, `${label}.url`);
  if (!url.startsWith("/"))
    throw new Error(`Invalid boundary response: ${label}.url`);
  const window = {
    url,
    window_start_sec: finite(
      value.window_start_sec,
      `${label}.window_start_sec`,
    ),
    window_end_sec: finite(value.window_end_sec, `${label}.window_end_sec`),
    duration_sec: finite(value.duration_sec, `${label}.duration_sec`),
    seam_offset_sec: finite(value.seam_offset_sec, `${label}.seam_offset_sec`),
  };
  if (
    window.window_end_sec <= window.window_start_sec ||
    window.duration_sec <= 0 ||
    window.seam_offset_sec < 0 ||
    window.seam_offset_sec > window.duration_sec
  )
    throw new Error(`Invalid boundary response: ${label} window bounds`);
  return window;
}

function parseEdit(value: unknown): BoundaryEdit {
  if (!isRecord(value))
    throw new Error("Invalid boundary response: actual_edit");
  if (value.kind === "roll") {
    return {
      kind: "roll",
      left_clip_id: text(value.left_clip_id, "actual_edit.left_clip_id"),
      right_clip_id: text(value.right_clip_id, "actual_edit.right_clip_id"),
      delta_sec: finite(value.delta_sec, "actual_edit.delta_sec"),
    };
  }
  if (
    value.kind === "trim" &&
    value.mode === "ripple" &&
    (value.edge === "in" || value.edge === "out")
  ) {
    return {
      kind: "trim",
      clip_id: text(value.clip_id, "actual_edit.clip_id"),
      edge: value.edge,
      source_sec: finite(value.source_sec, "actual_edit.source_sec"),
      mode: "ripple",
    };
  }
  throw new Error("Invalid boundary response: actual_edit kind");
}

function parseContext(value: unknown): BoundaryContext {
  if (!isRecord(value) || !isRecord(value.current) || !isRecord(value.limits))
    throw new Error("Invalid boundary context response");
  if (
    value.limits.fine_step_sec !== 0.001 ||
    value.limits.regular_step_sec !== 0.01
  )
    throw new Error("Invalid boundary response: precision steps");
  const context: BoundaryContext = {
    target: parseTarget(value.target),
    token: text(value.token, "token"),
    track_id: text(value.track_id, "track_id"),
    geometry: parseGeometry(value.geometry),
    current: {
      source_sec: finite(value.current.source_sec, "current.source_sec"),
      timeline_sec: finite(value.current.timeline_sec, "current.timeline_sec"),
    },
    limits: {
      min: finite(value.limits.min, "limits.min"),
      max: finite(value.limits.max, "limits.max"),
      fine_step_sec: 0.001,
      regular_step_sec: 0.01,
    },
  };
  if (context.limits.max < context.limits.min)
    throw new Error("Invalid boundary response: reversed limits");
  return context;
}

function parseAudition(value: unknown): BoundaryAudition {
  if (!isRecord(value)) throw new Error("Invalid boundary audition response");
  return {
    token: text(value.token, "token"),
    actual_edit: parseEdit(value.actual_edit),
    current: parseWindow(value.current, "current"),
    proposed: parseWindow(value.proposed, "proposed"),
  };
}

export async function loadBoundaryContext(
  path: string,
  target: BoundaryTarget,
  expectedGeometry: BoundaryGeometryClip[],
  signal?: AbortSignal,
): Promise<BoundaryContext> {
  const guestToken = shareTokenFromKey(path);
  const url = guestToken
    ? `${reviewApiBase(guestToken)}/daw/boundary/context`
    : "/api/boundary/context";
  if (isShareProjectKey(path) && !guestToken)
    throw new Error("Invalid guest boundary project key");
  const response = await (guestToken ? fetch : hostFetch)(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(guestToken ? {} : { path }),
      target,
      expected_geometry: expectedGeometry,
    }),
    signal,
  });
  if (!response.ok) {
    const message = await readApiError(response);
    throw new Error(`${response.status} ${message}`);
  }
  const context = parseContext((await response.json()) as unknown);
  if (!sameTarget(context.target, target))
    throw new Error("Invalid boundary response: target mismatch");
  return context;
}

export async function auditionBoundary(
  path: string,
  target: BoundaryTarget,
  edit: BoundaryEdit,
  expectedToken: string,
  signal?: AbortSignal,
): Promise<BoundaryAudition> {
  const response = await hostFetch("/api/boundary/audition", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path,
      target,
      edit,
      expected_token: expectedToken,
      pad_sec: 0.8,
    }),
    signal,
  });
  if (!response.ok) {
    const message = await readApiError(response);
    throw new Error(`${response.status} ${message}`);
  }
  const audition = parseAudition((await response.json()) as unknown);
  if (!sameTarget(audition.actual_edit, target))
    throw new Error("Invalid boundary response: audition target mismatch");
  return audition;
}

/** Resolves only server-issued host API paths and keeps audio auth separate from the preview token. */
export function boundaryAudioUrl(path: string, expectedToken: string): string {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("Invalid boundary audio URL");
  const url = new URL(path, window.location.origin);
  url.searchParams.set("expected_token", expectedToken);
  return withSessionTokenQuery(`${url.pathname}${url.search}${url.hash}`);
}
