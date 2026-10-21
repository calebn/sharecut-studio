import { describe, expect, it } from "vitest";
import { type ImportEdge, importEdges, isTestOrStoryFile } from "./importGraph";
import { sourceFiles } from "./sourceFiles";

/**
 * Frontend import direction. A module may import its own layer and any layer
 * below it. Importing a higher layer is a back edge and fails this test unless
 * it is in `BACK_EDGE_ALLOWLIST`.
 */
const LAYERS = [
  "types",
  "utils",
  "state",
  "document",
  "api",
  "services",
  "commands/edit",
  "hooks",
  "views",
] as const;
type Layer = (typeof LAYERS)[number];

/**
 * Where each top-level entry of `src/` sits. An entry the table does not name
 * fails `places every source directory and root file in a layer`, so a new
 * directory must be placed here. Entries the architecture issue does not name
 * are placed by what they hold. A directory that mixes roles sits with the role
 * the layers below the views depend on, and its remaining back edges are
 * allowlisted rather than hidden by a lower placement.
 */
const LAYER_TABLE: readonly {
  layer: Layer;
  entries: readonly string[];
  why: string;
}[] = [
  { layer: "types", entries: ["types"], why: "Plain data shapes." },
  {
    layer: "utils",
    entries: [
      "utils",
      "capabilities",
      "shareMode",
      "shareRoute",
      "sessionAuth",
    ],
    why: "Pure helpers. `capabilities` is copy strings. `shareMode`, `shareRoute` and `sessionAuth` read the URL and token with no React or store.",
  },
  {
    layer: "state",
    entries: ["state", "session", "presence"],
    why: "The one store plus the wire-format and presence math it and the sync code share. `presence` also holds a few hooks; they count as state here.",
  },
  {
    layer: "document",
    entries: ["document"],
    why: "The immutable server view, pending drafts and project patching.",
  },
  {
    layer: "api",
    entries: ["api"],
    why: "HTTP adapters: the `api.ts` facade and `api/`.",
  },
  {
    layer: "services",
    entries: ["services", "sync", "audio", "waveform", "ingest"],
    why: "Non-UI orchestration over api and state: the command queue, socket sync, playback and metering engines, waveform caches and rasterising, file ingest.",
  },
  {
    layer: "commands/edit",
    entries: ["commands", "edit", "agentic"],
    why: "User actions: the command registry, the pure edit kernels, and the WebMCP bridge that exposes the registry to agents.",
  },
  {
    layer: "hooks",
    entries: ["hooks", "prosody", "desktop", "keymap"],
    why: "React glue: shared hooks, single-hook directories, and the window shortcut listener.",
  },
  {
    layer: "views",
    entries: [
      "App",
      "dawApp",
      "main",
      "TransportEngine",
      "comments",
      "extensions",
      "feedback",
      "home",
      "inspector",
      "layout",
      "panels",
      "record",
      "timeline",
      "tracks",
      "transcript",
      "ui",
      "test",
      "storybook",
    ],
    why: "Components and the shells that mount them. `test` and `storybook` hold fixtures: nothing below the views may import them.",
  },
];

const LAYER_OF = new Map<string, Layer>(
  LAYER_TABLE.flatMap(({ layer, entries }) =>
    entries.map((entry) => [entry, layer] as const),
  ),
);

/** `record/Lobby.tsx` and `record/upload/params` give `record`; `api.ts` and `api` give `api`. */
function entryOf(path: string): string {
  return path.replace(/\.[jt]sx?$/, "").split("/")[0];
}

function layerOf(path: string): Layer {
  const layer = LAYER_OF.get(entryOf(path));
  if (!layer) {
    throw new Error(
      `${path} is under src/${entryOf(path)}, which has no layer. Add it to LAYER_TABLE in src/test/importDirection.test.ts.`,
    );
  }
  return layer;
}

const rank = (layer: Layer) => LAYERS.indexOf(layer);

const edgeId = (e: ImportEdge) => `${e.from} -> ${e.to} (${e.kind})`;

type Source = { rel: string; text: string };

/** Every import in a non-test file whose target sits in a higher layer. */
function backEdges(files: Iterable<Source>): Map<string, ImportEdge> {
  const found = new Map<string, ImportEdge>();
  for (const { rel, text } of files) {
    if (isTestOrStoryFile(rel)) {
      continue;
    }
    const fromRank = rank(layerOf(rel));
    for (const edge of importEdges(rel, text)) {
      if (rank(layerOf(edge.to)) > fromRank) {
        found.set(edgeId(edge), edge);
      }
    }
  }
  return found;
}

/** Back edges missing from `allowed`, and allowed ones no source has any more. */
function checkImportDirection(
  files: Iterable<Source>,
  allowed: ReadonlySet<string>,
): { violations: string[]; stale: string[] } {
  const found = backEdges(files);
  return {
    violations: [...found.keys()].filter((id) => !allowed.has(id)).sort(),
    stale: [...allowed].filter((id) => !found.has(id)).sort(),
  };
}

/**
 * Today's back edges as `importer -> target (kind)`, grouped by
 * `importer layer -> target layer`. Each phase of the architecture epic
 * deletes entries here and edits the sizes asserted below. Nothing is added.
 */
const BACK_EDGE_ALLOWLIST: Record<string, readonly string[]> = {
  "utils -> state": [
    "utils/pendingReviewPass.ts -> state/dawStore (static)",
    "utils/transcript.ts -> presence/anchors (static)",
  ],
  "utils -> document": [
    "utils/pendingReviewPass.ts -> document/authorityState (static)",
  ],
  "utils -> api": ["utils/tightenIntensity.ts -> api (type)"],
  "utils -> services": ["utils/waveformViewPref.ts -> waveform/types (type)"],
  "utils -> commands/edit": [
    "utils/speakerSplit.ts -> edit/rangeSelection (static)",
  ],
  "utils -> views": [
    "utils/pendingReviewPass.ts -> feedback/ask (type)",
    "utils/tightenHits.ts -> feedback/ask (type)",
    "utils/tightenIntensity.ts -> feedback/ask (type)",
  ],
  "state -> document": [
    "state/documentSendOrder.ts -> document/authorityState (static)",
    "state/projectSlice.ts -> document/authorityState (static)",
    "state/projectSlice.ts -> document/pendingDrafts (static)",
  ],
  "state -> api": ["state/runAnnouncedJob.ts -> api (static)"],
  "state -> services": [
    "presence/usePresencePublisher.ts -> audio/playbackClock (static)",
    "state/types.ts -> waveform/types (type)",
  ],
  "state -> commands/edit": [
    "state/projectSlice.ts -> edit/clipEdgePreview (type)",
    "state/projectSlice.ts -> edit/ripplePreview (static)",
    "state/types.ts -> edit/ripplePreview (dynamic)",
  ],
  "state -> hooks": [
    "presence/useLivePresenceClients.ts -> hooks/useIntervalTick (static)",
    "state/uiSlice.ts -> hooks/useViewportClass (static)",
  ],
  "state -> views": ["state/types.ts -> timeline/hitRouting (type)"],
  "document -> api": [
    "document/applyDocumentUpdate.ts -> api/project (static)",
    "document/hydrateTranscriptDetail.ts -> api/project (static)",
  ],
  "document -> services": [
    "document/applyDocumentUpdate.ts -> sync/inboundQueue (static)",
  ],
  "document -> commands/edit": [
    "document/projectPatch.ts -> edit/clipMove (static)",
    "document/projectPatch.ts -> edit/clipMove (type)",
  ],
  "api -> services": [
    "api/documentEdits.ts -> services/commandQueue (static)",
    "api/mediaSession.ts -> audio/proxyMath (dynamic)",
    "api/transcriptTiming.ts -> waveform/types (type)",
    "api/waveform.ts -> waveform/types (type)",
  ],
  "api -> commands/edit": [
    "api/boundary.ts -> edit/clipEdgePreview (type)",
    "api/clipBleed.ts -> edit/bleedAttenuation (type)",
    "api/documentEdits.ts -> edit/clipEdgePreview (type)",
  ],
  "api -> views": [
    "api/sharesRecord.ts -> record/types (type)",
    "api/sharesRecord.ts -> record/upload/params (static)",
    "api/sharesRecord.ts -> record/upload/transport (type)",
  ],
  "services -> commands/edit": [
    "audio/pendingPreview.ts -> edit/rangeSelection (static)",
    "audio/proxyMath.ts -> edit/joinRender (static)",
  ],
  "services -> views": [
    "ingest/dropLabels.ts -> feedback/ask (type)",
    "ingest/ingestFiles.ts -> feedback/ask (static)",
  ],
  "commands/edit -> hooks": [
    "commands/projectMedia.ts -> desktop/useDesktopCloseGuard (static)",
    "edit/dragThreshold.ts -> hooks/gestureConstants (static)",
  ],
  "commands/edit -> views": [
    "commands/editing.ts -> feedback/ask (static)",
    "commands/editing.ts -> tracks/trackMuteCopy (static)",
    "commands/gestures.ts -> timeline/inputContract (type)",
    "commands/host.ts -> extensions/features (static)",
    "commands/host.ts -> record (static)",
    "commands/projectMedia.ts -> feedback/ask (static)",
    "commands/rangeActions.ts -> comments/commentAnchor (static)",
    "commands/tighten.ts -> feedback/ask (static)",
    "commands/trackMix.ts -> tracks/trackMuteCopy (static)",
    "commands/transcriptIgnore.ts -> transcript/ignoredWords (static)",
    "commands/transcriptIgnore.ts -> transcript/transcriptModeCopy (static)",
    "commands/transcriptReview.ts -> transcript/lowConfidence (static)",
    "edit/clipMove.ts -> timeline/snapOverlay (static)",
    "edit/nudge.ts -> timeline/pendingEdgeDrag (static)",
  ],
  "hooks -> views": [
    "hooks/useHostSync.ts -> record (static)",
    "hooks/useKeyboardInset.ts -> ui/focusAndReveal (static)",
    "hooks/useOfflineAttentionAnnouncement.ts -> layout/attentionLabel (static)",
    "hooks/useShortTouchScreen.ts -> layout/useCompactInspector (static)",
    "hooks/useWaveformSnapTicks.ts -> timeline/snapOverlay (static)",
    "keymap/listener.ts -> ui/modalGate (static)",
  ],
};

const ALLOWED_IDS = Object.values(BACK_EDGE_ALLOWLIST).flat();
const ALLOWED = new Set(ALLOWED_IDS);

/** Allowlist entries per layer pair today. A phase that deletes one edits this. */
const ALLOWLIST_SIZE_BY_PAIR = {
  "utils -> state": 2,
  "utils -> document": 1,
  "utils -> api": 1,
  "utils -> services": 1,
  "utils -> commands/edit": 1,
  "utils -> views": 3,
  "state -> document": 3,
  "state -> api": 1,
  "state -> services": 2,
  "state -> commands/edit": 3,
  "state -> hooks": 2,
  "state -> views": 1,
  "document -> api": 2,
  "document -> services": 1,
  "document -> commands/edit": 2,
  "api -> services": 4,
  "api -> commands/edit": 3,
  "api -> views": 3,
  "services -> commands/edit": 2,
  "services -> views": 2,
  "commands/edit -> hooks": 2,
  "commands/edit -> views": 14,
  "hooks -> views": 6,
};
const ALLOWLIST_SIZE = 62;

const ID_SHAPE = /^(.+) -> (.+) \((static|type|dynamic)\)$/;

describe("layer table", () => {
  const files = [...sourceFiles()];

  it("places every source directory and root file in a layer", () => {
    const unplaced = files
      .filter(({ rel }) => !isTestOrStoryFile(rel))
      .filter(({ rel }) => !LAYER_OF.has(entryOf(rel)))
      .map(({ rel }) => rel);
    expect(unplaced).toEqual([]);
  });

  it("names only entries that exist and puts none in two layers", () => {
    const present = new Set(files.map(({ rel }) => entryOf(rel)));
    const entries = LAYER_TABLE.flatMap((row) => row.entries);
    expect(entries.filter((entry) => !present.has(entry))).toEqual([]);
    expect(new Set(entries).size).toBe(entries.length);
  });

  it("orders the layers as the architecture states", () => {
    expect(LAYERS.join(" -> ")).toBe(
      "types -> utils -> state -> document -> api -> services -> commands/edit -> hooks -> views",
    );
    expect(LAYER_TABLE.map((row) => row.layer)).toEqual([...LAYERS]);
  });

  it("explains every placement", () => {
    for (const { why } of LAYER_TABLE) {
      expect(why.trim().length).toBeGreaterThan(0);
    }
  });

  it("rejects a new directory that no layer names", () => {
    expect(() => layerOf("brandNew/Thing.tsx")).toThrow(
      /brandNew.*no layer.*LAYER_TABLE/,
    );
    expect(() =>
      checkImportDirection(
        [{ rel: "state/x.ts", text: 'import { a } from "../brandNew/a";' }],
        ALLOWED,
      ),
    ).toThrow(/brandNew/);
  });
});

describe("import direction", () => {
  it("has no back edge outside the allowlist, and no stale allowlist entry", () => {
    const { violations, stale } = checkImportDirection(sourceFiles(), ALLOWED);
    expect({ violations, stale }).toEqual({ violations: [], stale: [] });
  });

  it("sizes the allowlist exactly, in total and per layer pair", () => {
    expect(ALLOWED_IDS).toHaveLength(ALLOWLIST_SIZE);
    expect(ALLOWED.size).toBe(ALLOWLIST_SIZE);
    expect(
      Object.fromEntries(
        Object.entries(BACK_EDGE_ALLOWLIST).map(([pair, ids]) => [
          pair,
          ids.length,
        ]),
      ),
    ).toEqual(ALLOWLIST_SIZE_BY_PAIR);
  });

  it("files every entry under the layer pair it crosses, in the same layer order", () => {
    const misfiled: string[] = [];
    for (const [pair, ids] of Object.entries(BACK_EDGE_ALLOWLIST)) {
      for (const id of ids) {
        const match = ID_SHAPE.exec(id);
        if (!match) {
          misfiled.push(id);
          continue;
        }
        const actual = `${layerOf(match[1])} -> ${layerOf(match[2])}`;
        if (actual !== pair) {
          misfiled.push(`${id} is ${actual}, filed under ${pair}`);
        }
      }
    }
    expect(misfiled).toEqual([]);
    const sorted = Object.values(BACK_EDGE_ALLOWLIST).map((ids) =>
      [...ids].sort(),
    );
    expect(Object.values(BACK_EDGE_ALLOWLIST)).toEqual(sorted);
  });
});

describe("sabotage: the checker fails a new back edge", () => {
  it.each([
    [
      "a static import",
      "state/newSlice.ts",
      'import { useThing } from "../hooks/useThing";',
      "state/newSlice.ts -> hooks/useThing (static)",
    ],
    [
      "a type import",
      "utils/newHelper.ts",
      'import type { Props } from "../layout/Panel";',
      "utils/newHelper.ts -> layout/Panel (type)",
    ],
    [
      "an inline type-only import",
      "document/newPatch.ts",
      'import { type A, type B } from "../commands/execute";',
      "document/newPatch.ts -> commands/execute (type)",
    ],
    [
      "a dynamic import",
      "services/newQueue.ts",
      'async function f() { const { run } = await import("../commands/execute"); return run; }',
      "services/newQueue.ts -> commands/execute (dynamic)",
    ],
    [
      "a re-export",
      "api/newBarrel.ts",
      'export * from "../timeline/ClipBlock";',
      "api/newBarrel.ts -> timeline/ClipBlock (static)",
    ],
    [
      "a side-effect import",
      "types/newTypes.ts",
      'import "../state/dawStore";',
      "types/newTypes.ts -> state/dawStore (static)",
    ],
    [
      "a facade import from a lower layer",
      "state/newDrain.ts",
      'import { postThing } from "../api";',
      "state/newDrain.ts -> api (static)",
    ],
    [
      "a fixture import from production code",
      "utils/newFixtureUse.ts",
      'import { project } from "../test/fixtures";',
      "utils/newFixtureUse.ts -> test/fixtures (static)",
    ],
  ])("reports %s", (_name, rel, text, id) => {
    expect(checkImportDirection([{ rel, text }], ALLOWED)).toEqual({
      violations: [id],
      stale: [...ALLOWED].sort(),
    });
  });

  it("reports the same back edge added next to a real allowlisted one", () => {
    const real = sourceFiles();
    const sabotaged = [
      ...real,
      {
        rel: "state/sabotage.ts",
        text: 'import { x } from "../hooks/useIntervalTick";',
      },
    ];
    expect(checkImportDirection(sabotaged, ALLOWED)).toEqual({
      violations: ["state/sabotage.ts -> hooks/useIntervalTick (static)"],
      stale: [],
    });
  });

  it("flags an allowlisted edge whose source no longer has it", () => {
    const allowed = new Set([...ALLOWED, "state/gone.ts -> hooks/x (static)"]);
    expect(checkImportDirection(sourceFiles(), allowed)).toEqual({
      violations: [],
      stale: ["state/gone.ts -> hooks/x (static)"],
    });
  });

  it("allows an edge to the same layer, a lower layer, and from a test file", () => {
    expect(
      checkImportDirection(
        [
          { rel: "state/a.ts", text: 'import { b } from "./b";' },
          { rel: "state/a2.ts", text: 'import { t } from "../utils/time";' },
          {
            rel: "layout/Panel.tsx",
            text: 'import { s } from "../state/dawStore"; import "./panel.css";',
          },
          {
            rel: "state/a.test.ts",
            text: 'import { v } from "../layout/Panel";',
          },
          {
            rel: "utils/Thing.stories.tsx",
            text: 'import { v } from "../layout/Panel";',
          },
          {
            rel: "test/fixtures.ts",
            text: 'import { v } from "../layout/Panel";',
          },
        ],
        new Set(),
      ),
    ).toEqual({ violations: [], stale: [] });
  });
});

describe("importEdges", () => {
  const edges = (text: string) => importEdges("timeline/Lane.tsx", text);

  it.each([
    ['import a from "./a";', [{ to: "timeline/a", kind: "static" }]],
    ['import { a } from "../state/x";', [{ to: "state/x", kind: "static" }]],
    ['import * as a from "../x";', [{ to: "x", kind: "static" }]],
    ['import a, { b } from "../x";', [{ to: "x", kind: "static" }]],
    ['import a, * as b from "../x";', [{ to: "x", kind: "static" }]],
    ['import type { A } from "../x";', [{ to: "x", kind: "type" }]],
    ['import type A from "../x";', [{ to: "x", kind: "type" }]],
    ['import { type A, type B } from "../x";', [{ to: "x", kind: "type" }]],
    ['import { type A, b } from "../x";', [{ to: "x", kind: "static" }]],
    ['import {} from "../x";', [{ to: "x", kind: "static" }]],
    ['export { a } from "../x";', [{ to: "x", kind: "static" }]],
    ['export type { A } from "../x";', [{ to: "x", kind: "type" }]],
    ['export * from "../x";', [{ to: "x", kind: "static" }]],
    ['export * as ns from "../x";', [{ to: "x", kind: "static" }]],
    ['import "./side";', [{ to: "timeline/side", kind: "static" }]],
    [
      'const m = await import("../state/x");',
      [{ to: "state/x", kind: "dynamic" }],
    ],
    [
      'const { a } = await import(\n  "../state/x"\n);',
      [{ to: "state/x", kind: "dynamic" }],
    ],
    [
      'type T = typeof import("../state/x");',
      [{ to: "state/x", kind: "type" }],
    ],
    ['import { a } from "../hooks/index";', [{ to: "hooks", kind: "static" }]],
    ['import { a } from "../api.ts";', [{ to: "api", kind: "static" }]],
    [
      'import w from "./raster.worker?worker";',
      [{ to: "timeline/raster.worker", kind: "static" }],
    ],
    ['import {\n  a,\n  b,\n} from "../x";', [{ to: "x", kind: "static" }]],
  ])("reads %j", (text, expected) => {
    expect(edges(text)).toEqual(
      expected.map((e) => ({ from: "timeline/Lane.tsx", ...e })),
    );
  });

  it.each([
    'import React from "react";',
    'import { a } from "zustand/shallow";',
    'import css from "./lane.css";',
    'import logo from "../assets/logo.svg";',
    'import data from "./data.json";',
    'import { x } from "../../../package";',
    '// import { a } from "../state/x";',
    '/* import { a } from "../state/x"; */',
    '/* multi\nline import { a } from "../state/x"; */',
    'const s = "text"; // await import("../state/x")',
    "const url = `${a}`; // import b from './b'",
    "const x = foo.from('../x');",
    'export const from = "../x";',
    "const m = import(`../state/${name}`);",
  ])("ignores %j", (text) => {
    expect(edges(text)).toEqual([]);
  });

  it("does not mistake a // inside a string for a comment", () => {
    expect(
      edges('const u = "https://x.test/a"; import("../state/x");'),
    ).toEqual([{ from: "timeline/Lane.tsx", to: "state/x", kind: "dynamic" }]);
  });

  it("reads an import inside a template literal hole", () => {
    expect(edges("const s = `${await import('../state/x')}`;")).toEqual([
      { from: "timeline/Lane.tsx", to: "state/x", kind: "dynamic" },
    ]);
  });

  it("resolves a root file's relative imports", () => {
    expect(
      importEdges("App.tsx", 'import { a } from "./home/HomeScreen";'),
    ).toEqual([{ from: "App.tsx", to: "home/HomeScreen", kind: "static" }]);
  });
});
