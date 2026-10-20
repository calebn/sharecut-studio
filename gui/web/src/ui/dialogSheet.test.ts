/**
 * A `Dialog` is a sheet on phone and tablet (`docs/interaction-system.md`
 * § Dialogs, sheets and confirms). The one way out is `anchor`: a panel
 * beside the thing it is about, in the top layer, on every shell (#1795).
 * Leaving the sheet costs the thumb-zone footer and the three zones, so each
 * use writes `reason` in the anchor it passes, as a literal at the call site.
 */
import { describe, expect, it } from "vitest";
import { jsxElements } from "../test/jsxElements";
import { sourceFiles } from "../test/sourceFiles";

const MIN_REASON_CHARS = 30;

type Optout = { where: string; reason: string | null };

/** Every `<Dialog … anchor=…>` in the source text, with the reason it writes. */
export function dialogSheetOptouts(rel: string, text: string): Optout[] {
  const found: Optout[] = [];
  for (const element of jsxElements(text.replace(/<Dialog\b/g, "<dialog "))) {
    if (!element.text.startsWith("<dialog ")) continue;
    const anchor = /\banchor=\{\{([\s\S]*?)\}\}/.exec(element.text);
    if (!/\banchor=/.test(element.text)) continue;
    const reason = anchor
      ? (/\breason:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/.exec(anchor[1]) ?? [])
          .slice(1)
          .find((part) => part !== undefined)
      : undefined;
    found.push({
      where: `${rel}:${element.line}`,
      reason: reason?.trim() ?? null,
    });
  }
  return found;
}

describe("dialog sheet opt-out", () => {
  it("reads the reason from an inline anchor and nothing else", () => {
    const withReason = `<Dialog open anchor={{ reason: "stays beside the seam it is about", ref }} />`;
    const without = "<Dialog open anchor={{ ref }} />";
    const passedIn = "<Dialog open anchor={anchor} />";
    const sheet = "<Dialog open onClose={close} />";
    expect(dialogSheetOptouts("a.tsx", withReason)).toEqual([
      { where: "a.tsx:1", reason: "stays beside the seam it is about" },
    ]);
    expect(dialogSheetOptouts("a.tsx", without)[0].reason).toBeNull();
    expect(dialogSheetOptouts("a.tsx", passedIn)[0].reason).toBeNull();
    expect(dialogSheetOptouts("a.tsx", sheet)).toEqual([]);
  });

  it("gives every anchored Dialog a reason written at its call site", () => {
    const unreasoned: string[] = [];
    let optouts = 0;
    for (const { rel, text } of sourceFiles()) {
      if (!rel.endsWith(".tsx") || /\.(test|stories)\./.test(rel)) continue;
      for (const { where, reason } of dialogSheetOptouts(rel, text)) {
        optouts += 1;
        if (!reason || reason.length < MIN_REASON_CHARS) {
          unreasoned.push(where);
        }
      }
    }
    expect(optouts).toBeGreaterThan(0);
    expect(unreasoned).toEqual([]);
  });
});
