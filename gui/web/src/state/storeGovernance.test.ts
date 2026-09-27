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
 * Start of an inline selector passed to `useDaw(`, `useDawStore(` or
 * `useShallow(` (also `useDawStore(useShallow(`): an arrow whose parameter
 * is a name (group 1) or a destructuring pattern (group 2), optionally typed.
 */
const SELECTOR_START =
  /\b(?:useDaw(?:Store)?|useShallow)\(\s*(?:useShallow\(\s*)?\(?\s*(?:(\w+)|\{([^}]*)\})(?:\s*:\s*[\w.<>[\]]+)?\s*\)?\s*=>/g;

/** `text` from `from` up to the `)` closing the call already open there. */
function callBody(text: string, from: number): string {
  let depth = 1;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(from, i);
      }
    }
  }
  return text.slice(from);
}

/**
 * Hot-field reads in `text`: any `s.<field>`, plus, inside an inline store
 * selector, `<param>.<field>` for a parameter of any other name and any hot
 * field named in a destructuring parameter (reported as `{ field }`).
 * Handler reads (`useDawStore.getState().field`, `ctx.field`) never match.
 */
function hotFieldReads(text: string): string[] {
  const reads = [...text.matchAll(HOT_FIELD_READ)].map((m) => m[0]);
  for (const m of text.matchAll(SELECTOR_START)) {
    const [, param, pattern] = m;
    if (pattern !== undefined) {
      for (const f of pattern.matchAll(HOT_FIELD_NAME)) {
        reads.push(`{ ${f[1]} }`);
      }
      continue;
    }
    if (param === undefined || param === "s") {
      continue; // `s.<field>` is already counted above
    }
    const body = callBody(text, (m.index ?? 0) + m[0].length);
    const paramRead = new RegExp(
      `\\b${param}\\.(${HOT_FIELD_ALTERNATION})\\b`,
      "g",
    );
    for (const f of body.matchAll(paramRead)) {
      reads.push(f[0]);
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
