import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SRC_ROOT,
  sourceFiles,
  srcRelative,
  walkTsFiles,
} from "../test/sourceFiles";

/**
 * Whole-store reads: `useDaw()` / `useDawStore()` with no selector, or with an
 * inline arrow identity selector such as `(s) => s`, `(s: DawState) => s`,
 * `(s) => { return s; }`, optionally wrapped in `useShallow(...)` or followed
 * by extra arguments (`(s) => s, shallow`). All subscribe to every store
 * change. A named identity function (`useDaw(identity)`) is not detected.
 */
const WHOLE_STORE_READ =
  /\buseDaw(?:Store)?\(\s*(?:(?:useShallow\(\s*)?\(?\s*(\w+)(?:\s*:\s*[\w.<>[\]]+)?\s*\)?\s*=>\s*(?:\1|\{\s*return\s+\1\s*;?\s*\})\s*\)?\s*(?:,[^)]*)?)?\)/g;

function wholeStoreReads(text: string): number {
  return text.match(WHOLE_STORE_READ)?.length ?? 0;
}

/**
 * Hot fields change every frame (playhead, scroll) or every presence frame.
 * Only leaves select them; handlers read `useDawStore.getState()`.
 */
const HOT_FIELDS = [
  "playheadSec",
  "scrollLeft",
  "sessionClients",
  "pointerTrackId",
  "bladeHoverSec",
] as const;
const HOT_FIELD_ALTERNATION = HOT_FIELDS.join("|");

/** `s.<hot field>` anywhere: the repo's selector parameter convention. */
const HOT_FIELD_READ = new RegExp(`\\bs\\.(${HOT_FIELD_ALTERNATION})\\b`, "g");

/** A hot field's bare name, for a destructuring selector parameter. */
const HOT_FIELD_NAME = new RegExp(`\\b(${HOT_FIELD_ALTERNATION})\\b`, "g");

/**
 * Where an inline selector starts: just past `useDaw(`, `useDawStore(` or
 * `useShallow(` (also `useDawStore(useShallow(`). `selectorAt` parses the
 * function (if any) from there.
 */
const SELECTOR_CALL =
  /\b(?:useDaw(?:Store)?|useShallow)\(\s*(?:useShallow\(\s*)?/g;

/**
 * Where a hoisted selector starts: an arrow or `function` whose first
 * parameter is annotated with a type naming `DawState`, e.g.
 * `(st: DawState) =>` or `function pick(st: Pick<DawState, "scrollLeft">)`.
 */
const TYPED_SELECTOR =
  /(?:\bfunction\b\s*\w*\s*)?\(\s*(?:\w+|\{[^)]*?\})\s*:[^)]*\bDawState\b/g;

/** Index of the first non-whitespace character at or after `from`. */
function skipSpace(text: string, from: number): number {
  return from + (/^\s*/.exec(text.slice(from))?.[0].length ?? 0);
}

/**
 * Index just past a string literal, template literal or comment starting at
 * `i`, or `i` itself when none starts there, so the bracket scans below never
 * count a bracket inside one. A template's `${...}` holes are skipped with
 * `closeOf`, so a literal nested in a hole is skipped too. Regex literals are
 * not recognised.
 */
function skipLiteral(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"' || ch === "'") {
    let j = i + 1;
    while (j < text.length && text[j] !== ch && text[j] !== "\n") {
      j += text[j] === "\\" ? 2 : 1;
    }
    return Math.min(j + 1, text.length);
  }
  if (ch === "`") {
    let j = i + 1;
    while (j < text.length && text[j] !== "`") {
      if (text[j] === "\\") {
        j += 2;
      } else if (text.startsWith("${", j)) {
        j = closeOf(text, j + 2, "{", "}");
      } else {
        j += 1;
      }
    }
    return Math.min(j + 1, text.length);
  }
  if (text.startsWith("//", i)) {
    const eol = text.indexOf("\n", i);
    return eol === -1 ? text.length : eol + 1;
  }
  if (text.startsWith("/*", i)) {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 2;
  }
  return i;
}

/** Index just past the `close` matching an `open` already open before `from`. */
function closeOf(
  text: string,
  from: number,
  open: string,
  close: string,
): number {
  let depth = 1;
  let i = from;
  while (i < text.length) {
    const skipped = skipLiteral(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (text[i] === open) {
      depth += 1;
    } else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
    i += 1;
  }
  return text.length;
}

/**
 * A function body starting at `from`: a `{ ... }` block, or an expression
 * running to a `,` / `;` at depth 0 or to the bracket closing an outer call.
 */
function bodyAt(text: string, from: number): string {
  const start = skipSpace(text, from);
  if (text[start] === "{") {
    return text.slice(start, closeOf(text, start + 1, "{", "}"));
  }
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const skipped = skipLiteral(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = text[i];
    if ("([{".includes(ch)) {
      depth += 1;
    } else if (")]}".includes(ch)) {
      depth -= 1;
      if (depth < 0) {
        return text.slice(start, i);
      }
    } else if ((ch === "," || ch === ";") && depth === 0) {
      return text.slice(start, i);
    }
    i += 1;
  }
  return text.slice(start);
}

/**
 * Where a function's body starts, given the index just past its parameter
 * list: past the `=>` of an arrow, or at the `{` of a `function` block,
 * after skipping an optional return-type annotation (`: number`,
 * `: { a: number }`, `: Pick<DawState, "a">`). `undefined` when neither
 * follows (the parentheses were not a parameter list).
 */
function bodyStartAfter(text: string, paramsEnd: number): number | undefined {
  let i = skipSpace(text, paramsEnd);
  if (text[i] === ":") {
    const typeStart = i + 1;
    let depth = 0;
    i = typeStart;
    while (i < text.length) {
      const skipped = skipLiteral(text, i);
      if (skipped !== i) {
        i = skipped;
        continue;
      }
      const ch = text[i];
      if (text.startsWith("=>", i)) {
        if (depth === 0) {
          break;
        }
        i += 2; // a function type's arrow, e.g. `: Array<() => void>`
        continue;
      }
      if (depth === 0 && ch === "{" && text.slice(typeStart, i).trim() !== "") {
        break; // a `function` block after a non-empty return type
      }
      if ("([{<".includes(ch)) {
        depth += 1;
      } else if (")]}>".includes(ch)) {
        depth -= 1;
        if (depth < 0) {
          return undefined;
        }
      } else if (depth === 0 && (ch === ";" || ch === ",")) {
        return undefined;
      }
      i += 1;
    }
  }
  if (text.startsWith("=>", i)) {
    return i + 2;
  }
  return text[i] === "{" ? i : undefined;
}

/** A parsed selector: its first parameter's name or destructuring pattern, and its body. */
type Selector = { param?: string; pattern?: string; body: string };

/**
 * The arrow or `function` expression starting at `from` (after optional
 * whitespace). A destructuring pattern is taken with balanced braces, so a
 * nested pattern stays whole; a parameter type annotation is skipped with
 * the rest of the parameter list, and a return-type annotation by
 * `bodyStartAfter`. `undefined` when no function starts there (e.g. a
 * named selector, `useDaw(pick)`).
 */
function selectorAt(text: string, from: number): Selector | undefined {
  const rest = text.slice(from);
  const bare = /^\s*(\w+)\s*=>/.exec(rest);
  if (bare) {
    return { param: bare[1], body: bodyAt(text, from + bare[0].length) };
  }
  const head = /^\s*(?:\bfunction\b\s*\w*\s*)?\(\s*/.exec(rest);
  if (!head) {
    return undefined;
  }
  const paramsStart = from + head[0].length;
  const paramsEnd = closeOf(text, paramsStart, "(", ")");
  const bodyStart = bodyStartAfter(text, paramsEnd);
  if (bodyStart === undefined) {
    return undefined;
  }
  const body = bodyAt(text, bodyStart);
  if (text[paramsStart] === "{") {
    const patternEnd = closeOf(text, paramsStart + 1, "{", "}");
    return { pattern: text.slice(paramsStart, patternEnd), body };
  }
  const name = /^\w+/.exec(text.slice(paramsStart));
  return name ? { param: name[0], body } : undefined;
}

/** Hot-field reads by one parsed selector (see `hotFieldReads`). */
function selectorReads({ param, pattern, body }: Selector): string[] {
  if (pattern !== undefined) {
    return [...pattern.matchAll(HOT_FIELD_NAME)].map((f) => `{ ${f[1]} }`);
  }
  if (param === undefined || param === "s") {
    return []; // `s.<field>` is already counted by HOT_FIELD_READ
  }
  const paramRead = new RegExp(
    `\\b${param}\\.(${HOT_FIELD_ALTERNATION})\\b`,
    "g",
  );
  return [...body.matchAll(paramRead)].map((f) => f[0]);
}

/**
 * Hot-field reads in `text`: any `s.<field>`, plus, in a store selector,
 * `<param>.<field>` for a parameter of any other name and any hot field named
 * in a (possibly nested) destructuring parameter (reported as `{ field }`).
 * A store selector is an arrow or `function` expression passed inline to
 * `useDaw` / `useDawStore` / `useShallow`, or any arrow or `function` whose
 * first parameter's type names `DawState` (a hoisted selector). Handler
 * reads (`useDawStore.getState().field`, `ctx.field`) never match. Brackets
 * inside strings, template literals and comments do not end a selector early.
 */
function hotFieldReads(text: string): string[] {
  const reads = [...text.matchAll(HOT_FIELD_READ)].map((m) => m[0]);
  const starts = new Set([
    ...[...text.matchAll(SELECTOR_CALL)].map(
      (m) => (m.index ?? 0) + m[0].length,
    ),
    ...[...text.matchAll(TYPED_SELECTOR)].map((m) => m.index ?? 0),
  ]);
  for (const from of starts) {
    const selector = selectorAt(text, from);
    if (selector !== undefined) {
      reads.push(...selectorReads(selector));
    }
  }
  return reads;
}

function isTestFile(rel: string): boolean {
  return /\.test\.[jt]sx?$/.test(rel);
}

type AllowEntry = { file: string; reason: string };

/**
 * Files allowed to read a hot field directly: leaves that isolate a hot
 * field's own re-renders from their ancestors (playhead/scroll/presence/
 * pointer ticks), and non-component code (command context, store slices,
 * pure math) that legitimately reads current transport/presence state
 * outside of React render. Every other file must select hot fields only
 * through a memoized leaf like these.
 */
const HOT_FIELD_ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "commands/context.ts",
    reason: "builds the command ctx snapshot at execute time, not render",
  },
  {
    file: "commands/editing.ts",
    reason:
      "falls back to the current playhead when a blade atTime arg is omitted",
  },
  {
    file: "hooks/useAudioTransport.ts",
    reason: "drives audio transport from the live playhead",
  },
  {
    file: "hooks/useFollowTransport.ts",
    reason:
      "computes follow-mode transport targets from presence and the playhead",
  },
  {
    file: "hooks/useFollowUi.ts",
    reason: "derives follow-mode UI state from the presence roster",
  },
  {
    file: "hooks/useFollowViewport.ts",
    reason: "derives follow-mode viewport targets from the presence roster",
  },
  {
    file: "hooks/useProxyTransport.ts",
    reason: "mirrors the live playhead to a proxy transport",
  },
  {
    file: "hooks/useSnapTicks.ts",
    reason:
      "computes snap ticks from the live playhead and blade hover position",
  },
  {
    file: "layout/AvatarStack.tsx",
    reason: "leaf that reads the presence roster itself",
  },
  {
    file: "layout/FollowBanner.tsx",
    reason: "leaf that reads the presence roster itself",
  },
  {
    file: "layout/ListenPlayhead.tsx",
    reason: "leaf that reads the live playhead itself",
  },
  {
    file: "layout/PresenceStatus.tsx",
    reason:
      "leaf that reads the presence roster itself, isolating StatusBar from presence frames",
  },
  {
    file: "layout/TransportTimecode.tsx",
    reason:
      "leaf that reads the live playhead itself, isolating the transport bar from playhead ticks",
  },
  {
    file: "panels/TranscriptPanel.tsx",
    reason: "follows the live playhead to auto-scroll the transcript",
  },
  {
    file: "presence/PresenceGhostLayer.tsx",
    reason: "leaf that reads the presence roster itself",
  },
  {
    file: "presence/presenceSummary.ts",
    reason: "selectAgentPresent reduces the presence roster to a boolean",
  },
  {
    file: "presence/usePresenceCursorSource.ts",
    reason: "publishes the local scroll position to presence",
  },
  {
    file: "presence/usePresencePublisher.ts",
    reason: "publishes the live playhead and scroll position to presence",
  },
  {
    file: "state/presenceSlice.ts",
    reason:
      "the presence slice's own actions read the playhead/roster to publish state",
  },
  {
    file: "state/storeMath.ts",
    reason: "pure scroll/zoom math evaluated at the current scroll position",
  },
  {
    file: "state/transportSlice.ts",
    reason:
      "the transport slice's own actions read and update the live playhead",
  },
  {
    file: "timeline/CommentPlaybackBubble.tsx",
    reason: "leaf that reads the live playhead itself",
  },
  {
    file: "timeline/EnvelopeOverlay.tsx",
    reason: "reads the current scroll position to draw only the visible chunk",
  },
  {
    file: "timeline/Playhead.tsx",
    reason: "leaf that reads the live playhead itself",
  },
  {
    file: "timeline/PresenceOverlay.tsx",
    reason: "leaf that reads the presence roster itself",
  },
  {
    file: "timeline/TimeRuler.tsx",
    reason: "leaf that reads the live playhead and scroll position itself",
  },
  {
    file: "timeline/TimelineLeaves.tsx",
    reason:
      "small leaves that read the live playhead, scroll and blade hover themselves",
  },
  {
    file: "timeline/WaveformLayer.tsx",
    reason: "reads the current scroll position to draw only the visible chunk",
  },
  {
    file: "timeline/followTarget.ts",
    reason: "derives the follow target from the presence roster",
  },
];

/** Files with a hot-field read outside `allow` (excluding test files). Pure, for a planted-fixture test and the whole-src scan. */
function hotFieldOffenders(
  files: Iterable<{ rel: string; text: string }>,
  allow: readonly AllowEntry[],
): string[] {
  const allowed = new Set(allow.map((e) => e.file));
  const offenders: string[] = [];
  for (const { rel, text } of files) {
    if (isTestFile(rel) || allowed.has(rel)) {
      continue;
    }
    if (hotFieldReads(text).length > 0) {
      offenders.push(rel);
    }
  }
  return offenders;
}

describe("store governance", () => {
  it.each([
    ["const { a } = useDaw();", 1],
    ["const s = useDawStore();", 1],
    ["const s = useDawStore(\n);", 1],
    ["useDaw(); useDawStore();", 2],
    ["const { a } = useDaw((s) => ({ a: s.a }));", 0],
    ["const a = useDawStore((s) => s.a);", 0],
    ["useDawStore.getState();", 0],
    ["const x = myuseDaw();", 0],
    ["const s = useDaw((s) => s);", 1],
    ["const s = useDawStore((state) => state);", 1],
    ["const s = useDaw(s => s);", 1],
    ["const s = useDawStore(\n  (s) => s,\n);", 1],
    ["const a = useDaw((s) => s.a);", 0],
    ["const t = useDaw((s) => t);", 0],
    ["const s = useDaw((s: DawState) => s);", 1],
    ["const s = useDawStore((s) => s, shallow);", 1],
    ["const s = useDawStore(useShallow((s) => s));", 1],
    ["const s = useDawStore(useShallow((s: DawState) => s));", 1],
    ["const s = useDaw((s) => { return s; });", 1],
    ["const a = useDaw((s: DawState) => s.a);", 0],
    ["const a = useDawStore((s) => s.a, shallow);", 0],
    ["const a = useDawStore(useShallow((s) => ({ a: s.a })));", 0],
    ["const a = useDaw((s) => { return s.a; });", 0],
    ["const a = useDawStore((s) => sx);", 0],
  ])("counts whole-store reads in %j", (text, expected) => {
    expect(wholeStoreReads(text)).toBe(expected);
  });

  it("reads the DAW store only through selectors outside tests", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = srcRelative(file);
      if (isTestFile(rel)) {
        continue;
      }
      scanned += 1;
      if (wholeStoreReads(readFileSync(file, "utf8")) > 0) {
        offenders.push(rel);
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it.each([
    ["useDaw((s) => ({ a: s.playheadSec }))", ["s.playheadSec"]],
    ["useDawStore((s) => s.scrollLeft)", ["s.scrollLeft"]],
    [
      "(s) => s.sessionClients.length + s.bladeHoverSec",
      ["s.sessionClients", "s.bladeHoverSec"],
    ],
    ["useDawStore.getState().pointerTrackId", []],
    ["useDawStore((s) => s.playheadSecs)", []],
    ["useDawStore((state) => state.playheadSec)", ["state.playheadSec"]],
    ["useDaw(({ sessionClients }) => sessionClients)", ["{ sessionClients }"]],
    ["useShallow((st) => ({ p: st.scrollLeft }))", ["st.scrollLeft"]],
    [
      "useDawStore(useShallow((st) => ({ p: st.scrollLeft })))",
      ["st.scrollLeft"],
    ],
    ["useDaw(({ playheadSec: p }: DawState) => p)", ["{ playheadSec }"]],
    ["useDawStore((state) => state.playheadSecs)", []],
    ["useDaw((st) => st.zoom); st.playheadSec", []],
    ["el.scrollLeft; ctx.playheadSec", []],
    [
      "useDaw(({ project: { tracks }, playheadSec }) => tracks)",
      ["{ playheadSec }"],
    ],
    [
      'useDaw(({ playheadSec }: Pick<DawState, "playheadSec">) => playheadSec)',
      ["{ playheadSec }"],
    ],
    [
      "const pick = (st: DawState) => st.playheadSec; useDaw(pick)",
      ["st.playheadSec"],
    ],
    ["useDaw(function (st) { return st.playheadSec; })", ["st.playheadSec"]],
    [
      "function pick(st: DawState) { return st.scrollLeft; }",
      ["st.scrollLeft"],
    ],
    ['const p = (st: Pick<DawState, "zoom">) => st.zoom; st.playheadSec', []],
    ["useDaw((st) => st.zoom, (a, b) => a === b); st.playheadSec", []],
    ["useDaw(pick)", []],
    [
      "function pick(st: DawState): number { return st.scrollLeft; }",
      ["st.scrollLeft"],
    ],
    [
      "const pick = (st: DawState): number => st.playheadSec;",
      ["st.playheadSec"],
    ],
    ["useDaw((st): number => st.playheadSec)", ["st.playheadSec"]],
    [
      "useDaw((st): { p: number } => ({ p: st.playheadSec }))",
      ["st.playheadSec"],
    ],
    ['useDaw((st) => st.mode === ")" || st.scrollLeft > 0)', ["st.scrollLeft"]],
    ["useDaw((st) => `${st.mode})` + st.bladeHoverSec)", ["st.bladeHoverSec"]],
    ["useDaw((st) => /* ) */ st.pointerTrackId)", ["st.pointerTrackId"]],
    [
      "useDaw((st) => {\n  // }\n  return st.sessionClients;\n})",
      ["st.sessionClients"],
    ],
    ['useDaw((st) => st.zoom + ")"); st.playheadSec', []],
  ])("finds hot field reads in %j", (text, expected) => {
    expect(hotFieldReads(text)).toEqual(expected);
  });

  it("flags a hot-field read outside the allowlist", () => {
    const files = [
      { rel: "timeline/TrackLane.tsx", text: "s.playheadSec" },
      { rel: "layout/TransportTimecode.tsx", text: "s.playheadSec" },
      { rel: "layout/StatusBar.test.tsx", text: "s.sessionClients" },
      {
        rel: "timeline/ClipBlock.tsx",
        text: "useDawStore((state) => state.pointerTrackId)",
      },
    ];
    expect(hotFieldOffenders(files, HOT_FIELD_ALLOWLIST)).toEqual([
      "timeline/TrackLane.tsx",
      "timeline/ClipBlock.tsx",
    ]);
  });

  it("finds no hot-field read outside the allowlist in the real source tree", () => {
    const offenders = hotFieldOffenders(sourceFiles(), HOT_FIELD_ALLOWLIST);
    expect(offenders).toEqual([]);
  });

  it.each(HOT_FIELD_ALLOWLIST)(
    "$file still reads a hot field (stale allowlist entry)",
    ({ file }) => {
      const text = readFileSync(join(SRC_ROOT, file), "utf8");
      expect(hotFieldReads(text).length).toBeGreaterThan(0);
    },
  );

  it.each(HOT_FIELD_ALLOWLIST)("$file has a non-empty reason", ({ reason }) => {
    expect(reason.trim().length).toBeGreaterThan(0);
  });

  it("keeps the DAW store free of waveform modules", () => {
    const text = readFileSync(join(SRC_ROOT, "state/dawStore.ts"), "utf8");
    expect(text).not.toMatch(/from\s+["'][./]*waveform\//);
  });
});
