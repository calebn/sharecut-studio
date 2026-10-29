import { describe, expect, it } from "vitest";
import {
  importEdges,
  isTestOrStoryFile,
  stripComments,
} from "../test/importGraph";
import { sourceFiles } from "../test/sourceFiles";

/**
 * `gui/web/README.md` states three rules. Each is checked here against
 * production source with an allowlist sized at today's count. A phase that
 * migrates an allowlisted file deletes its entry and edits the sizes below.
 */
type Source = { rel: string; text: string };

const production = (files: Iterable<Source>): Source[] =>
  [...files].filter(({ rel }) => !isTestOrStoryFile(rel));

describe("README rule: api.ts is the facade", () => {
  /**
   * Components, hooks and state import the named exports of `api.ts`. Only
   * `api/` itself (and `api.ts`, which re-exports it) names an adapter module.
   * Tests may mock an adapter directly and are not scanned.
   */
  function adapterImports(files: Iterable<Source>): string[] {
    const pairs = new Set<string>();
    for (const { rel, text } of production(files)) {
      if (rel === "api.ts" || rel.startsWith("api/")) {
        continue;
      }
      for (const edge of importEdges(rel, text)) {
        if (edge.to.startsWith("api/")) {
          pairs.add(`${edge.from} -> ${edge.to}`);
        }
      }
    }
    return [...pairs].sort();
  }

  /** Files that reach an `api/` adapter without the facade, each `importer -> adapter`. */
  const ALLOWLIST = [
    "audio/chunkCache.ts -> api/http",
    "audio/pendingPreview.ts -> api/documentTransport",
    "audio/pendingPreview.ts -> api/http",
    "commands/clipBleed.ts -> api/clipBleed",
    "commands/rangeActions.ts -> api/documentEdits",
    "commands/rangeActions.ts -> api/documentTransport",
    "commands/rangeActions.ts -> api/http",
    "commands/speakerMoveLaneSpan.ts -> api/documentEdits",
    "commands/speakerMoveLaneSpan.ts -> api/speakerMoveLaneSpan",
    "document/applyDocumentUpdate.ts -> api/project",
    "document/hydrateTranscriptDetail.ts -> api/project",
    "edit/clipBleedSession.ts -> api/clipBleed",
    "edit/clipEdgeSave.ts -> api/boundary",
    "edit/nudge.ts -> api/documentEdits",
    "extensions/features.ts -> api/http",
    "hooks/useGuestSync.ts -> api/project",
    "hooks/useProjectBootstrap.ts -> api/project",
    "hooks/useProjectPoll.ts -> api/project",
    "inspector/usePendingCutSuggestion.ts -> api/documentEdits",
    "inspector/views/PendingEditInspector.tsx -> api/documentEdits",
    "prosody/useProsodyOverlay.ts -> api/prosody",
    "record/recordBootstrap.ts -> api/http",
    "record/upload/http.ts -> api/http",
    "services/commandQueue.ts -> api/documentTransport",
    "stage/dialogs/useTunnelStatus.ts -> api/tunnelStatus",
    "timeline/ClipBlock.tsx -> api/boundary",
    "transcript/EditBoundaryMark.tsx -> api/boundary",
    "transcript/EditBoundaryMarkView.tsx -> api/boundary",
    "transcript/PrecisionBoundaryDialog.tsx -> api/boundary",
    "transcript/TranscriptWordbar.tsx -> api/transcriptTiming",
    "transcript/boundaryPresentation.ts -> api/boundary",
  ];
  const ALLOWLIST_PAIRS = 31;
  const ALLOWLIST_FILES = 27;

  it("imports an api/ adapter directly only from the allowlist", () => {
    expect(adapterImports(sourceFiles())).toEqual(ALLOWLIST);
  });

  it("sizes the allowlist exactly", () => {
    expect(ALLOWLIST).toHaveLength(ALLOWLIST_PAIRS);
    expect(new Set(ALLOWLIST.map((p) => p.split(" -> ")[0])).size).toBe(
      ALLOWLIST_FILES,
    );
    expect([...ALLOWLIST].sort()).toEqual(ALLOWLIST);
  });

  it.each([
    ["a static import", 'import { f } from "../api/project";'],
    ["a type import", 'import type { T } from "../api/project";'],
    ["a dynamic import", 'const m = await import("../api/project");'],
    ["a re-export", 'export { f } from "../api/project";'],
  ])(
    "sabotage: flags a new component importing an adapter by %s",
    (_n, text) => {
      expect(
        adapterImports([
          ...sourceFiles(),
          { rel: "panels/NewPanel.tsx", text },
        ]),
      ).toEqual(["panels/NewPanel.tsx -> api/project", ...ALLOWLIST].sort());
    },
  );

  it("accepts the facade, the adapters' own imports, and tests", () => {
    expect(
      adapterImports([
        { rel: "panels/A.tsx", text: 'import { f } from "../api";' },
        { rel: "panels/B.tsx", text: 'import { f } from "../api.ts";' },
        { rel: "api/a.ts", text: 'import { f } from "./b";' },
        { rel: "api.ts", text: 'export * from "./api/project";' },
        {
          rel: "panels/A.test.tsx",
          text: 'import { f } from "../api/project";',
        },
      ]),
    ).toEqual([]);
  });
});

describe("README rule: prefer useProjectMutation", () => {
  /**
   * `hooks/useProjectMutation()` owns busy and error state for a call into the
   * API. A file that declares its own `[error, setError] = useState(...)` and
   * reaches the API (the facade or an adapter, static or dynamic) is the
   * try/catch boilerplate the hook replaces. Error state in a file that never
   * calls the API is not a mutation and is not counted.
   */
  const OWN_ERROR_STATE = /\[\s*error\s*,\s*setError\s*\]\s*=\s*useState\b/;

  function handRolledMutations(files: Iterable<Source>): string[] {
    return production(files)
      .filter(({ rel }) => rel !== "hooks/useProjectMutation.ts")
      .filter(({ text }) => OWN_ERROR_STATE.test(stripComments(text)))
      .filter(({ rel, text }) =>
        importEdges(rel, text).some(
          (e) => e.to === "api" || e.to.startsWith("api/"),
        ),
      )
      .map(({ rel }) => rel)
      .sort();
  }

  /** Files that keep their own error state beside an API call. */
  const ALLOWLIST: string[] = [
    "App.tsx",
    "comments/useCommentActions.ts",
    "comments/usePostComment.ts",
    "home/HelpDialog.tsx",
    "home/HomeScreen.tsx",
    "hooks/useProjectBootstrap.ts",
    "inspector/views/EnvelopeWorkspace.tsx",
    "stage/dialogs/ShareDialog.tsx",
  ];
  const ALLOWLIST_SIZE = 8;

  it("keeps API-call error state in useProjectMutation outside the allowlist", () => {
    expect(handRolledMutations(sourceFiles())).toEqual(ALLOWLIST);
  });

  it("sizes the allowlist exactly", () => {
    expect(ALLOWLIST).toHaveLength(ALLOWLIST_SIZE);
    expect([...ALLOWLIST].sort()).toEqual(ALLOWLIST);
  });

  it.each([
    [
      "the facade",
      'import { saveThing } from "../api";\nconst [error, setError] = useState<string | null>(null);',
    ],
    [
      "an adapter",
      'import { saveThing } from "../api/project";\nconst [error, setError] = useState(null);',
    ],
    [
      "a dynamic import",
      'const [error, setError] = useState<string | null>(null);\nconst { f } = await import("../api");',
    ],
  ])(
    "sabotage: flags a new file with its own error state and %s",
    (_n, text) => {
      expect(
        handRolledMutations([
          ...sourceFiles(),
          { rel: "panels/NewPanel.tsx", text },
        ]),
      ).toEqual([...ALLOWLIST, "panels/NewPanel.tsx"].sort());
    },
  );

  it("accepts error state with no API call, the hook itself, and tests", () => {
    expect(
      handRolledMutations([
        {
          rel: "record/useMic.ts",
          text: "const [error, setError] = useState<string | null>(null);",
        },
        {
          rel: "hooks/useProjectMutation.ts",
          text: 'import { x } from "../api";\nconst [error, setError] = useState(null);',
        },
        {
          rel: "panels/A.test.tsx",
          text: 'import { x } from "../api";\nconst [error, setError] = useState(null);',
        },
        {
          rel: "panels/B.tsx",
          text: 'import { x } from "../api";\nconst m = useProjectMutation();',
        },
      ]),
    ).toEqual([]);
  });
});

describe("README rule: one Zustand store", () => {
  /**
   * `state/dawStore.ts` is the DAW store. A file that imports a store factory
   * (`create`, `createStore`, `createWithEqualityFn`) from zustand builds
   * another one. Each other store is allowlisted with its reason.
   */
  const ZUSTAND_IMPORT =
    /\bimport\s+(?!type\b)\{([^}]*)\}\s*from\s*["']zustand(?:\/[\w-]+)?["']/g;
  const FACTORIES = new Set(["create", "createStore", "createWithEqualityFn"]);

  function storeFactories(files: Iterable<Source>): string[] {
    const found: string[] = [];
    for (const { rel, text } of production(files)) {
      const code = stripComments(text);
      const makes = [...code.matchAll(ZUSTAND_IMPORT)].some((m) =>
        m[1]
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/)[0])
          .some((name) => FACTORIES.has(name)),
      );
      if (makes) {
        found.push(rel);
      }
    }
    return found.sort();
  }

  const HOME = "state/dawStore.ts";
  const ALLOWLIST: readonly { file: string; reason: string }[] = [
    {
      file: "feedback/ask.ts",
      reason: "Holds the one pending confirm or text question.",
    },
    {
      file: "record/hostStore.ts",
      reason: "Host recording-room state, outside the DAW document.",
    },
  ];
  const ALLOWLIST_SIZE = 2;

  it("builds a store only in dawStore.ts and the allowlist", () => {
    expect(storeFactories(sourceFiles())).toEqual(
      [HOME, ...ALLOWLIST.map((e) => e.file)].sort(),
    );
  });

  it("sizes the allowlist exactly and explains each entry", () => {
    expect(ALLOWLIST).toHaveLength(ALLOWLIST_SIZE);
    for (const { reason } of ALLOWLIST) {
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["create", 'import { create } from "zustand";'],
    ["createStore", 'import { createStore } from "zustand/vanilla";'],
    [
      "createWithEqualityFn",
      'import { createWithEqualityFn as make } from "zustand/traditional";',
    ],
    [
      "create beside other names",
      'import { create, type StateCreator } from "zustand";',
    ],
  ])("sabotage: flags a new file building a store with %s", (_n, text) => {
    expect(
      storeFactories([...sourceFiles(), { rel: "panels/newStore.ts", text }]),
    ).toEqual(
      [HOME, ...ALLOWLIST.map((e) => e.file), "panels/newStore.ts"].sort(),
    );
  });

  it("accepts selectors, types, comments and tests", () => {
    expect(
      storeFactories([
        {
          rel: "a.ts",
          text: 'import { useShallow } from "zustand/react/shallow";',
        },
        { rel: "b.ts", text: 'import type { StateCreator } from "zustand";' },
        { rel: "c.ts", text: 'import { useStore } from "zustand";' },
        { rel: "d.ts", text: '// import { create } from "zustand";' },
        { rel: "e.test.ts", text: 'import { create } from "zustand";' },
      ]),
    ).toEqual([]);
  });
});
