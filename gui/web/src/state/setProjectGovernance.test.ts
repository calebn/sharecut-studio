import { describe, expect, it } from "vitest";
import { isTestOrStoryFile, stripComments } from "../test/importGraph";
import { sourceFiles } from "../test/sourceFiles";

/**
 * Pending command drafts produce the displayed view (docs/architecture.md,
 * "Document projection authority"). `setProject` replaces that view outright,
 * so only `document/` and the slice that defines it may call it. Every other
 * caller is an optimistic or preview write that bypasses the draft layer; each
 * is allowlisted with its call count, and a phase that routes one through
 * `document/` deletes the entry and edits the sizes below.
 */
const SET_PROJECT_CALL = /\bsetProject\s*\(/g;

function setProjectCalls(text: string): number {
  return stripComments(text).match(SET_PROJECT_CALL)?.length ?? 0;
}

function isAllowedHome(rel: string): boolean {
  return rel.startsWith("document/") || rel === "state/projectSlice.ts";
}

type Source = { rel: string; text: string };

/** Files calling `setProject(` outside the allowed homes, with their call counts. */
function outsideCalls(files: Iterable<Source>): Record<string, number> {
  const calls: Record<string, number> = {};
  for (const { rel, text } of files) {
    if (isTestOrStoryFile(rel) || isAllowedHome(rel)) {
      continue;
    }
    const count = setProjectCalls(text);
    if (count > 0) {
      calls[rel] = count;
    }
  }
  return calls;
}

/** Files allowed to call `setProject(` today, and how many calls each makes. */
const ALLOWLIST: readonly { file: string; calls: number; reason: string }[] = [
  {
    file: "commands/trackMix.ts",
    calls: 2,
    reason: "Track-mix overlay write and its revert while the overlay is live.",
  },
  {
    file: "inspector/useNudgeRun.ts",
    calls: 1,
    reason:
      "Pending-edit nudge preview; fade and envelope previews are drafts (#2009).",
  },
  {
    file: "timeline/precision/precisionDrivers.ts",
    calls: 1,
    reason:
      "Pending-edit precision preview; fade and envelope previews are drafts (#2009).",
  },
];

const ALLOWLIST_FILES = 3;
const ALLOWLIST_CALLS = 4;

const allowedCalls = Object.fromEntries(
  ALLOWLIST.map(({ file, calls }) => [file, calls]),
);

describe("setProject write governance", () => {
  it.each([
    ["state.setProject(next)", 1],
    ["useDawStore.getState().setProject(next);", 1],
    ["s.setProject(\n  patchTrackMix(p),\n);", 1],
    ["const { setProject } = store; setProject (x);", 1],
    ["a.setProject(x); b.setProject(y);", 2],
    ["setProject: (project) => {", 0],
    ["setProject: (project: ProjectView) => void;", 0],
    ["_setProject(x)", 0],
    ["resetProject(x)", 0],
    ["// state.setProject(x)", 0],
    ["/* state.setProject(x) */", 0],
    ["pass(setProject);", 0],
  ])("counts calls in %j", (text, expected) => {
    expect(setProjectCalls(text)).toBe(expected);
  });

  it("calls setProject outside document/ and the slice only from the allowlist", () => {
    expect(outsideCalls(sourceFiles())).toEqual(allowedCalls);
  });

  it("sizes the allowlist exactly", () => {
    expect(ALLOWLIST).toHaveLength(ALLOWLIST_FILES);
    expect(ALLOWLIST.reduce((sum, e) => sum + e.calls, 0)).toBe(
      ALLOWLIST_CALLS,
    );
    expect(new Set(ALLOWLIST.map((e) => e.file)).size).toBe(ALLOWLIST_FILES);
  });

  it("explains every allowlisted caller", () => {
    for (const { reason } of ALLOWLIST) {
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps the slice and document/ as the only other callers", () => {
    const homes = [...sourceFiles()]
      .filter(({ rel }) => !isTestOrStoryFile(rel) && isAllowedHome(rel))
      .filter(({ text }) => setProjectCalls(text) > 0)
      .map(({ rel }) => rel)
      .sort();
    expect(homes).toEqual([
      "document/applyDocumentUpdate.ts",
      "document/optimisticRevert.ts",
      "state/projectSlice.ts",
    ]);
  });

  describe("sabotage", () => {
    it("flags a new caller outside the allowed homes", () => {
      const sabotaged = [
        ...sourceFiles(),
        {
          rel: "layout/NewPanel.tsx",
          text: "useDawStore.getState().setProject(draft);",
        },
      ];
      expect(outsideCalls(sabotaged)).toEqual({
        ...allowedCalls,
        "layout/NewPanel.tsx": 1,
      });
    });

    it("flags an extra call in an allowlisted file", () => {
      const sabotaged = [...sourceFiles()].map((file) =>
        file.rel === "commands/trackMix.ts"
          ? { ...file, text: `${file.text}\ns.setProject(extra);` }
          : file,
      );
      expect(outsideCalls(sabotaged)).toEqual({
        ...allowedCalls,
        "commands/trackMix.ts": 3,
      });
    });

    it("accepts a call from document/ or the slice, and ignores tests", () => {
      expect(
        outsideCalls([
          { rel: "document/newWriter.ts", text: "s.setProject(x);" },
          { rel: "state/projectSlice.ts", text: "s.setProject(x);" },
          { rel: "layout/Panel.test.tsx", text: "s.setProject(x);" },
          { rel: "layout/Panel.stories.tsx", text: "s.setProject(x);" },
        ]),
      ).toEqual({});
    });
  });
});
