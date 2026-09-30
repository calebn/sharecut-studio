import type { ProjectView } from "../types/project";

const roots = [
  "project_path",
  "meta",
  "timeline_duration_sec",
  "tracks",
  "clips",
  "chapters",
  "pending_edits",
  "edit_boundaries",
  "applied_edits",
  "effects_by_track",
  "envelopes",
  "social_clips",
  "comments",
  "render_status",
  "edit_impact",
  "history",
  "transcript",
] as const;
type Root = (typeof roots)[number];
const collections = [
  "tracks",
  "chapters",
  "pending_edits",
  "edit_boundaries",
  "envelopes",
  "social_clips",
  "comments",
  "clip_rows",
  "effect_rows",
  "render_tracks",
  "invalidations",
  "impact_segments",
  "history_groups",
  "history_entries",
  "utterances",
  "applied_records",
] as const;
type Collection = (typeof collections)[number];
type Section = Root | Collection;
type ObjectValue = Record<string, unknown>;
type Splice<T> = { index: number; delete: number; insert: T };
type Span = { row: number; index: number; count: number };
type TextPart = { literal: string } | Span;
type WordsPart = { literal: ObjectValue[] } | Span;
type InsertedUtterance = {
  header: ObjectValue;
  text: TextPart;
  words?: WordsPart[];
};
type RowUpdate =
  | { index: number; value: ObjectValue }
  | {
      index: number;
      set: ObjectValue;
      unset: string[];
      text?: Splice<string>;
      words?: Splice<ObjectValue[]>;
      requires_words?: boolean;
      word_count?: number;
      point_edits?: Rows;
    };
type Rows = {
  before_count: number;
  splices: Splice<(ObjectValue | InsertedUtterance)[]>[];
  updates: RowUpdate[];
  row_encoding?: "predecessor-spans";
};
type Operation =
  | { type: "replace"; section: Section; parent: string | null; value: unknown }
  | { type: "remove"; section: Section; parent: string | null }
  | ({ type: "rows"; section: Collection; parent: string | null } & Rows);
export type ProjectionDelta = {
  base_seq: number;
  base_token: string;
  projection: string;
  audience: "host" | "guest";
  operations: Operation[];
};

const groups: Partial<Record<Root, readonly string[]>> = {
  clips: ["tracks"],
  applied_edits: ["records"],
  effects_by_track: [],
  render_status: ["tracks", "invalidations"],
  edit_impact: ["segments"],
  history: ["groups", "entries"],
  transcript: ["utterances"],
};
const children: Record<string, [Root, string]> = {
  clip_rows: ["clips", "tracks"],
  effect_rows: ["effects_by_track", ""],
  render_tracks: ["render_status", "tracks"],
  invalidations: ["render_status", "invalidations"],
  impact_segments: ["edit_impact", "segments"],
  history_groups: ["history", "groups"],
  history_entries: ["history", "entries"],
  utterances: ["transcript", "utterances"],
  applied_records: ["applied_edits", "records"],
};
const memberSections: Record<string, Collection> = {
  records: "applied_records",
  invalidations: "invalidations",
  segments: "impact_segments",
  groups: "history_groups",
  entries: "history_entries",
  utterances: "utterances",
};
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const MAX_ITEMS = 200_000;
const MAX_TEXT = 4_000_000;
function fail(): never {
  throw new Error("Invalid document delta or missing predecessor");
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  return value as ObjectValue;
}
function integer(value: unknown, max = MAX_ITEMS): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    return fail();
  return value;
}
function string(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.length > max) return fail();
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return fail();
  return value;
}
function fields(value: ObjectValue, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
}
function safeData(
  value: unknown,
  budget = { nodes: 500_000 },
  depth = 0,
): void {
  if (--budget.nodes < 0 || depth > 24) fail();
  if (typeof value === "string") {
    string(value);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    array(value);
    for (const child of value) safeData(child, budget, depth + 1);
    return;
  }
  const record = object(value);
  for (const [key, child] of Object.entries(record)) {
    if (forbidden.has(key)) fail();
    safeData(child, budget, depth + 1);
  }
}
function span(value: ObjectValue): Span {
  fields(value, ["row", "index", "count"]);
  return {
    row: integer(value.row),
    index: integer(value.index, MAX_TEXT),
    count: integer(value.count, MAX_TEXT),
  };
}
function inserted(value: unknown): InsertedUtterance {
  const row = object(value);
  fields(row, ["header", "text", "words"]);
  const header = object(row.header);
  if ("words" in header || "text" in header) fail();
  const text = object(row.text);
  let part: TextPart;
  if ("literal" in text) {
    fields(text, ["literal"]);
    part = { literal: string(text.literal) };
  } else part = span(text);
  const result: InsertedUtterance = { header, text: part };
  if ("words" in row)
    result.words = array(row.words).map((value) => {
      const words = object(value);
      if (!("literal" in words)) return span(words);
      fields(words, ["literal"]);
      return { literal: array(words.literal).map(object) };
    });
  return result;
}
function splice<T>(value: unknown, parse: (value: unknown) => T): Splice<T> {
  const edit = object(value);
  fields(edit, ["index", "delete", "insert"]);
  return {
    index: integer(edit.index, MAX_TEXT),
    delete: integer(edit.delete, MAX_TEXT),
    insert: parse(edit.insert),
  };
}
function rows(value: ObjectValue, section: Collection | "points"): Rows {
  const encoded = section === "utterances";
  if (
    encoded
      ? value.row_encoding !== "predecessor-spans"
      : "row_encoding" in value
  )
    fail();
  const edits = array(value.splices).map((item) =>
    splice(item, (values) => array(values).map(encoded ? inserted : object)),
  );
  const updates = array(value.updates).map((item): RowUpdate => {
    const update = object(item);
    const index = integer(update.index);
    if ("value" in update) {
      fields(update, ["index", "value"]);
      if (encoded || section === "envelopes") fail();
      return { index, value: object(update.value) };
    }
    if (!encoded && section !== "envelopes") fail();
    fields(update, [
      "index",
      "set",
      "unset",
      ...(encoded
        ? ["text", "words", "requires_words", "word_count"]
        : ["point_edits"]),
    ]);
    const set = object(update.set);
    const unset = array(update.unset).map((key) => string(key, 128));
    if ("words" in set || "text" in set || "points" in set) fail();
    const result: RowUpdate = { index, set, unset };
    if ("text" in update) result.text = splice(update.text, string);
    if ("words" in update) {
      if (typeof update.requires_words !== "boolean") fail();
      result.words = splice(update.words, (value) => array(value).map(object));
      result.requires_words = update.requires_words;
      result.word_count = integer(update.word_count);
    }
    if ("point_edits" in update) {
      const points = object(update.point_edits);
      fields(points, ["before_count", "splices", "updates"]);
      result.point_edits = rows(points, "points");
    }
    return result;
  });
  return {
    before_count: integer(value.before_count),
    splices: edits,
    updates,
    ...(encoded ? { row_encoding: "predecessor-spans" } : {}),
  };
}
function isRoot(value: string): value is Root {
  return roots.some((root) => root === value);
}
function isCollection(value: string): value is Collection {
  return collections.some((section) => section === value);
}
export function parseProjectionDelta(value: unknown): ProjectionDelta {
  safeData(value);
  const delta = object(value);
  fields(delta, [
    "base_seq",
    "base_token",
    "projection",
    "audience",
    "operations",
  ]);
  const baseToken = string(delta.base_token, 64);
  if (!/^[a-f0-9]{64}$/.test(baseToken)) fail();
  const operations = array(delta.operations);
  if (operations.length > 4096) fail();
  const projection = string(delta.projection, 32);
  const audience = delta.audience;
  if (audience !== "host" && audience !== "guest") fail();
  if (
    ![
      "shell",
      "full",
      "detail",
      "comments",
      "tracks",
      "clips",
      "fx",
      "envelopes",
      "mix",
      "transcript_audio",
    ].includes(projection)
  )
    fail();
  const targets = new Set<string>();
  return {
    base_seq: integer(delta.base_seq, Number.MAX_SAFE_INTEGER),
    base_token: baseToken,
    projection,
    audience,
    operations: operations.map((value) => {
      const op = object(value);
      const section = string(op.section, 64);
      if (!isRoot(section) && !isCollection(section)) return fail();
      const parent = op.parent === null ? null : string(op.parent, 512);
      if (
        (section === "clip_rows" || section === "effect_rows") !==
        (parent !== null)
      )
        fail();
      const target = JSON.stringify([section, parent]);
      if (targets.has(target)) fail();
      targets.add(target);
      if (op.type === "replace") {
        fields(op, ["type", "section", "parent", "value"]);
        if (isCollection(section)) array(op.value).forEach(object);
        else if (section === "project_path") string(op.value);
        else if (section === "timeline_duration_sec") {
          if (typeof op.value !== "number") fail();
        } else if (!(section === "transcript" && op.value === null))
          object(op.value);
        return { type: "replace", section, parent, value: op.value };
      }
      if (op.type === "remove") {
        if (isRoot(section)) fail();
        fields(op, ["type", "section", "parent"]);
        return { type: "remove", section, parent };
      }
      if (op.type !== "rows" || !isCollection(section)) return fail();
      fields(op, [
        "type",
        "section",
        "parent",
        "before_count",
        "splices",
        "updates",
        "row_encoding",
      ]);
      return { type: "rows", section, parent, ...rows(op, section) };
    }),
  };
}

const sectionKey = (section: string, parent: string | null = null) =>
  JSON.stringify([section, parent]);
function split(view: ProjectView): Map<string, unknown> {
  const sections = new Map<string, unknown>();
  for (const root of roots) {
    if (!Object.hasOwn(view, root)) continue;
    const value: unknown = view[root];
    const members = groups[root];
    if (!members || value === null) {
      sections.set(sectionKey(root), value);
      continue;
    }
    const record = object(value);
    if (root === "effects_by_track") {
      sections.set(sectionKey(root), {});
      for (const [track, values] of Object.entries(record))
        sections.set(sectionKey("effect_rows", track), values);
      continue;
    }
    const meta = Object.fromEntries(
      Object.entries(record).filter(([field]) => !members.includes(field)),
    );
    sections.set(sectionKey(root), meta);
    for (const member of members) {
      if (!(member in record)) continue;
      const part = record[member];
      if (member === "tracks") {
        if (root === "clips") {
          meta.tracks = {};
          for (const [track, values] of Object.entries(object(part)))
            sections.set(sectionKey("clip_rows", track), values);
        } else
          sections.set(
            sectionKey("render_tracks"),
            Object.entries(object(part)).map(([key, value]) => ({
              key,
              value,
            })),
          );
      } else sections.set(sectionKey(memberSections[member]), part);
    }
  }
  return sections;
}
function range(index: number, count: number, length: number): void {
  if (index > length || count > length - index) fail();
}
type ApplyBudget = { items: number; text: number };
function spend(
  budget: ApplyBudget,
  kind: keyof ApplyBudget,
  count: number,
): void {
  budget[kind] -= count;
  if (budget[kind] < 0) fail();
}
function textSpan(
  part: TextPart,
  previous: ObjectValue[],
  budget: ApplyBudget,
): string {
  if ("literal" in part) return part.literal;
  const text = string(object(previous[part.row]).text);
  spend(budget, "text", text.length);
  const value = Array.from(text);
  range(part.index, part.count, value.length);
  return value.slice(part.index, part.index + part.count).join("");
}
function restore(
  row: InsertedUtterance,
  previous: ObjectValue[],
  budget: ApplyBudget,
): ObjectValue {
  const result: ObjectValue = {
    ...row.header,
    text: textSpan(row.text, previous, budget),
  };
  if (row.words) {
    const words: ObjectValue[] = [];
    for (const part of row.words) {
      const values =
        "literal" in part
          ? part.literal
          : array(object(previous[part.row]).words);
      const index = "literal" in part ? 0 : part.index;
      const count = "literal" in part ? values.length : part.count;
      range(index, count, values.length);
      spend(budget, "items", count);
      if (words.length + count > MAX_ITEMS) fail();
      for (let i = index; i < index + count; i++) words.push(object(values[i]));
    }
    result.words = words;
  }
  return result;
}
function applyRows(
  input: unknown,
  op: Rows,
  budget: ApplyBudget,
): ObjectValue[] {
  const source = array(input);
  spend(budget, "items", source.length);
  const previous = source.map(object);
  if (previous.length !== op.before_count) fail();
  const output: ObjectValue[] = [];
  let cursor = 0;
  for (const edit of op.splices) {
    range(edit.index, edit.delete, previous.length);
    if (edit.index < cursor) fail();
    for (let i = cursor; i < edit.index; i++) output.push(previous[i]);
    for (const value of edit.insert) {
      output.push(
        op.row_encoding
          ? restore(inserted(value), previous, budget)
          : object(value),
      );
      if (output.length > MAX_ITEMS) fail();
    }
    cursor = edit.index + edit.delete;
  }
  for (let i = cursor; i < previous.length; i++) output.push(previous[i]);
  if (output.length > MAX_ITEMS) fail();
  const seen = new Set<number>();
  for (const update of op.updates) {
    if (seen.has(update.index) || update.index >= output.length) fail();
    seen.add(update.index);
    if ("value" in update) {
      output[update.index] = update.value;
      continue;
    }
    const row: ObjectValue = { ...output[update.index], ...update.set };
    output[update.index] = row;
    for (const field of update.unset) {
      if (forbidden.has(field)) fail();
      delete row[field];
    }
    if (update.point_edits)
      row.points = applyRows(row.points, update.point_edits, budget);
    if (update.text) {
      const text = string(row.text ?? "");
      spend(budget, "text", text.length + update.text.insert.length);
      const value = Array.from(text);
      const edit = update.text;
      range(edit.index, edit.delete, value.length);
      row.text =
        value.slice(0, edit.index).join("") +
        edit.insert +
        value.slice(edit.index + edit.delete).join("");
      string(row.text);
    }
    if (update.words) {
      if (
        update.requires_words &&
        (!Array.isArray(row.words) || row.words.length !== update.word_count)
      )
        fail();
      const value = row.words === undefined ? [] : array(row.words);
      spend(budget, "items", value.length + update.words.insert.length);
      const edit = update.words;
      range(edit.index, edit.delete, value.length);
      row.words = [
        ...value.slice(0, edit.index),
        ...edit.insert,
        ...value.slice(edit.index + edit.delete),
      ];
      array(row.words);
    }
  }
  return output;
}

export function applyProjectionDelta(
  before: ProjectView,
  delta: ProjectionDelta,
): ProjectView {
  const budget: ApplyBudget = { items: 1_000_000, text: 8_000_000 };
  const sections = split(before);
  const touched = new Set<string>();
  for (const op of delta.operations) {
    const key = sectionKey(op.section, op.parent);
    touched.add(children[op.section]?.[0] ?? op.section);
    if (op.type === "remove") sections.delete(key);
    else if (op.type === "replace") sections.set(key, op.value);
    else sections.set(key, applyRows(sections.get(key), op, budget));
  }
  const result: Record<string, unknown> = { ...before };
  for (const root of roots) {
    if (!touched.has(root)) continue;
    const key = sectionKey(root);
    if (!sections.has(key)) {
      delete result[root];
      continue;
    }
    const value = sections.get(key);
    result[root] =
      groups[root] && value !== null ? { ...object(value) } : value;
  }
  for (const [section, [root, member]] of Object.entries(children)) {
    if (!touched.has(root) || result[root] === null) continue;
    const parent = object(result[root]);
    if (section === "clip_rows" || section === "effect_rows") {
      const target: ObjectValue = {};
      for (const [encoded, values] of sections) {
        const [candidate, track] = JSON.parse(encoded) as [
          string,
          string | null,
        ];
        if (candidate === section && track !== null) target[track] = values;
      }
      if (section === "clip_rows") parent.tracks = target;
      else result[root] = target;
    } else {
      const key = sectionKey(section);
      if (!sections.has(key)) continue;
      const value = sections.get(key);
      parent[member] =
        section === "render_tracks"
          ? Object.fromEntries(
              array(value).map((row) => {
                const entry = object(row);
                return [string(entry.key), entry.value];
              }),
            )
          : value;
    }
  }
  return result as unknown as ProjectView;
}

export function applyOrderedCommentRows(
  input: unknown,
  edits: unknown,
): unknown[] {
  safeData(edits);
  const value = object(edits);
  fields(value, ["before_count", "splices", "updates"]);
  return applyRows(input, rows(value, "comments"), {
    items: 1_000_000,
    text: 8_000_000,
  });
}
