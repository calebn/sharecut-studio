/**
 * A control changes the view or the playhead through `execute`, not through a
 * store setter (#1795). The command is where the follow break, the gate, the
 * argument checks and the announcement live: a control that called
 * `setPlayheadSec` directly moved the playhead without breaking the viewer's
 * follow of the host, because `transport.seek` was skipped.
 *
 * Each setter below is owned by a catalog command that breaks follow. A `.tsx`
 * file under `src/` (a control or a panel) may not call, select or pass one;
 * hooks, stores and command handlers (`.ts`) are where the setter runs. A
 * waiver needs the reason the call is not a user action.
 */
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../test/sourceFiles";
import { COMMANDS } from "./catalog";

/** Store setter → the catalog command that owns the change. */
const COMMAND_OWNED_SETTERS: Record<string, string> = {
  setPlayheadSec: "transport.seek",
  applyAnchoredZoom: "view.zoomIn",
  fitToWindow: "view.fit",
  openStage: "stage.edit",
  setReviewSection: "stage.review",
  setEditSurface: "stage.edit",
};

const WAIVERS: { file: string; setter: string; reason: string }[] = [
  {
    file: "timeline/TimelineView.tsx",
    setter: "fitToWindow",
    reason:
      "the first layout fits the session to the stage on its own; no press asked for it, so there is no follow to break",
  },
];

function withoutCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/"[^"\n]*"/g, '""')
    .replace(/'[^'\n]*'/g, "''");
}

/** The setter is read from a store, called bare, or handed on as a prop. */
function usesSetter(text: string, setter: string): boolean {
  return new RegExp(
    `\\.${setter}\\b|(?<![.\\w])${setter}\\(|=\\{${setter}\\}`,
  ).test(withoutCommentsAndStrings(text));
}

describe("control setters", () => {
  it("recognizes a store read, a bare call and a prop hand-off", () => {
    expect(
      usesSetter("setPlayheadSec: s.setPlayheadSec,", "setPlayheadSec"),
    ).toBe(true);
    expect(
      usesSetter('onClick={() => setPlayheadSec("x")}', "setPlayheadSec"),
    ).toBe(true);
    expect(usesSetter("onSeek={setPlayheadSec}", "setPlayheadSec")).toBe(true);
    expect(usesSetter("// setPlayheadSec(x)", "setPlayheadSec")).toBe(false);
    expect(
      usesSetter('runPointerCommand("transport.seek")', "setPlayheadSec"),
    ).toBe(false);
  });

  it("owns each setter with a catalog command that breaks follow", () => {
    for (const [setter, commandId] of Object.entries(COMMAND_OWNED_SETTERS)) {
      expect(
        COMMANDS[commandId]?.breaksFollow,
        `${setter} → ${commandId}`,
      ).toBe(true);
    }
  });

  it("calls no command-owned setter from a .tsx control", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (!rel.endsWith(".tsx") || /\.(test|stories)\./.test(rel)) continue;
      for (const setter of Object.keys(COMMAND_OWNED_SETTERS)) {
        const waived = WAIVERS.some(
          (w) => w.file === rel && w.setter === setter,
        );
        if (usesSetter(text, setter) && !waived) {
          offenders.push(
            `${rel} uses ${setter}; run ${COMMAND_OWNED_SETTERS[setter]} instead`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every waiver live", () => {
    const sources = new Map(
      [...sourceFiles()].map(({ rel, text }) => [rel, text]),
    );
    const stale = WAIVERS.filter(
      (w) =>
        !(w.setter in COMMAND_OWNED_SETTERS) ||
        !usesSetter(sources.get(w.file) ?? "", w.setter) ||
        w.reason.length < 30,
    ).map((w) => `${w.file} ${w.setter}`);
    expect(stale).toEqual([]);
  });
});
