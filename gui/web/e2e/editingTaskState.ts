export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type DurableState = {
  duration_sec: number;
  stable: Json;
  sources: {
    id: string;
    path: string;
    speaker: string | null;
    label: string | null;
    offset_sec: number;
    duration_sec: number | null;
    sample_rate: number | null;
    channels: number | null;
    clipping_regions: Json[];
    clipping_truncated: boolean;
  }[];
  clips: {
    id: string;
    track_id: string;
    source_start: number;
    source_end: number;
    timeline_start: number;
    source_id: string | null;
    fade_in_ms: number;
    fade_out_ms: number;
    join_in_mode: string;
    mute_regions: Json[];
  }[];
  tracks: {
    id: string;
    fader_db: number;
    gain_db: number;
    muted: boolean;
    role: string;
    media: Json;
    invariants: Json;
  }[];
  envelopes: {
    track_id: string;
    parameter: string;
    points: { id: string; time: number; value: number }[];
  }[];
  comments: {
    id: string;
    body: string;
    author: string;
    timeline_start: number;
    timeline_end: number | null;
    track_ids: string[];
    resolved: boolean;
    resolved_by: string | null;
    review_version_id: string | null;
    edit_decision_id: string | null;
    timeline_spans: { start: number; end: number }[];
    action_items: {
      id: string;
      text: string;
      done: boolean;
      completed_by: string | null;
    }[];
    replies: { id: string; body: string; author: string }[];
  }[];
};
export function parseDurableState(input: unknown): DurableState {
  const object = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected durable object");
    return value as Record<string, unknown>;
  };
  const rows = (value: unknown): Record<string, unknown>[] => {
    if (!Array.isArray(value)) throw new Error("Expected durable collection");
    return value.map(object);
  };
  const finite = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value);
  const state = object(input);
  if (!finite(state.duration_sec) || state.stable === undefined)
    throw new Error("Invalid durable extent or stable remainder");
  const sourceIds = new Set<string>();
  for (const source of rows(state.sources)) {
    if (
      !["id", "path"].every((key) => typeof source[key] === "string") ||
      !["speaker", "label"].every(
        (key) => source[key] === null || typeof source[key] === "string",
      ) ||
      !finite(source.offset_sec) ||
      !(source.duration_sec === null || finite(source.duration_sec)) ||
      !(source.sample_rate === null || Number.isInteger(source.sample_rate)) ||
      !(source.channels === null || Number.isInteger(source.channels)) ||
      !Array.isArray(source.clipping_regions) ||
      typeof source.clipping_truncated !== "boolean" ||
      sourceIds.has(source.id as string)
    )
      throw new Error("Invalid or duplicate durable source identity");
    sourceIds.add(source.id as string);
  }
  for (const clip of rows(state.clips)) {
    if (
      !["id", "track_id", "join_in_mode"].every(
        (key) => typeof clip[key] === "string",
      ) ||
      ![
        "source_start",
        "source_end",
        "timeline_start",
        "fade_in_ms",
        "fade_out_ms",
      ].every((key) => finite(clip[key])) ||
      !(clip.source_id === null || typeof clip.source_id === "string") ||
      !Array.isArray(clip.mute_regions)
    )
      throw new Error("Invalid durable clip geometry");
    if (clip.source_id !== null && !sourceIds.has(clip.source_id as string))
      throw new Error("Durable clip references a missing source");
  }
  for (const track of rows(state.tracks))
    if (
      typeof track.id !== "string" ||
      !finite(track.fader_db) ||
      !finite(track.gain_db) ||
      typeof track.muted !== "boolean" ||
      typeof track.role !== "string" ||
      track.media === undefined ||
      track.invariants === undefined
    )
      throw new Error("Invalid durable track mix");
  for (const envelope of rows(state.envelopes)) {
    if (
      typeof envelope.track_id !== "string" ||
      typeof envelope.parameter !== "string"
    )
      throw new Error("Invalid durable envelope");
    for (const point of rows(envelope.points))
      if (
        typeof point.id !== "string" ||
        !finite(point.time) ||
        !finite(point.value)
      )
        throw new Error("Invalid durable envelope point");
  }
  for (const comment of rows(state.comments)) {
    if (
      !["id", "body", "author"].every(
        (key) => typeof comment[key] === "string",
      ) ||
      !finite(comment.timeline_start) ||
      !(comment.timeline_end === null || finite(comment.timeline_end)) ||
      typeof comment.resolved !== "boolean" ||
      !Array.isArray(comment.track_ids) ||
      !comment.track_ids.every((id) => typeof id === "string") ||
      !["resolved_by", "review_version_id", "edit_decision_id"].every(
        (key) => comment[key] === null || typeof comment[key] === "string",
      )
    )
      throw new Error("Invalid durable comment");
    for (const span of rows(comment.timeline_spans))
      if (
        !finite(span.start) ||
        !finite(span.end) ||
        (span.start as number) < 0 ||
        (span.end as number) <= (span.start as number)
      )
        throw new Error("Invalid durable comment span");
    for (const item of rows(comment.action_items))
      if (
        typeof item.id !== "string" ||
        typeof item.text !== "string" ||
        typeof item.done !== "boolean" ||
        !(item.completed_by === null || typeof item.completed_by === "string")
      )
        throw new Error("Invalid durable comment action item");
    for (const reply of rows(comment.replies))
      if (
        !["id", "body", "author"].every((key) => typeof reply[key] === "string")
      )
        throw new Error("Invalid durable comment reply");
  }
  return input as DurableState;
}
function differences(
  expected: Json,
  actual: Json | undefined,
  path: string,
  tolerance: Record<string, number>,
): string[] {
  if (
    typeof expected === "number" &&
    typeof actual === "number" &&
    Number.isFinite(actual) &&
    Math.abs(expected - actual) <= (tolerance[path] ?? 0)
  )
    return [];
  if (expected === actual) return [];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length)
      return [
        `${path} expected ${expected.length} items, observed ${actual.length}`,
      ];
    return expected.flatMap((value, index) =>
      differences(value, actual[index], `${path}.${index}`, tolerance),
    );
  }
  if (
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    actual !== null &&
    typeof actual === "object" &&
    !Array.isArray(actual)
  ) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].flatMap((key) =>
      differences(expected[key], actual[key], `${path}.${key}`, tolerance),
    );
  }
  return [
    `${path} expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`,
  ];
}
export function savedStateDifferences(
  expected: DurableState,
  actual: DurableState,
  prefix = "after",
  tolerances: Record<string, number> = {},
): string[] {
  for (const [label, state] of [
    ["expected", expected],
    ["observed", actual],
  ] as const)
    if (new Set(state.clips.map((clip) => clip.id)).size !== state.clips.length)
      return [`${prefix} ${label} clip IDs are not unique`];
  const identityState = (state: DurableState) => ({
    ...state,
    clips: Object.fromEntries(state.clips.map((clip) => [clip.id, clip])),
  });
  return differences(
    identityState(expected),
    identityState(actual),
    prefix,
    tolerances,
  );
}
