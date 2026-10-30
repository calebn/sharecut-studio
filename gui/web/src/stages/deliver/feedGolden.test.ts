import { describe, expect, it } from "vitest";
import type { FeedView, Fix } from "../../types/feedView";
import { applyFix, serve } from "./feedFixture";
import golden from "./feedGolden.json";

type Case = {
  name: string;
  view: keyof typeof golden.views;
  fix: Fix;
  then?: Fix;
  expect: {
    item?: Record<string, unknown>;
    channel?: Record<string, unknown>;
    show?: unknown;
    file?: string;
    findings?: { key: string | null; severity: string }[];
    notesHtmlIncludes?: string[];
    notesHtmlExcludes?: string[];
    itemXmlIncludes?: string[];
    itemXmlExcludes?: string[];
  };
};

describe("the shared (view, fix) -> view golden", () => {
  it.each(golden.cases as unknown as Case[])("$name", (c) => {
    let served = serve(golden.views[c.view] as unknown as FeedView);
    served = applyFix(served, c.fix);
    if (c.then) served = applyFix(served, c.then);
    const { view, itemXml } = served;
    const want = c.expect;
    for (const [key, fact] of Object.entries(want.item ?? {}))
      expect(view.item[key] ?? null).toEqual(fact);
    for (const [key, fact] of Object.entries(want.channel ?? {}))
      expect(view.channel[key] ?? null).toEqual(fact);
    if (want.show) expect(view.show).toEqual(want.show);
    if (want.file) expect(view.file).toBe(want.file);
    if (want.findings)
      expect(
        view.findings.map((f) => ({ key: f.key, severity: f.severity })),
      ).toEqual(want.findings);
    for (const text of want.notesHtmlIncludes ?? [])
      expect(view.notesHtml).toContain(text);
    for (const text of want.notesHtmlExcludes ?? [])
      expect(view.notesHtml).not.toContain(text);
    for (const text of want.itemXmlIncludes ?? [])
      expect(itemXml).toContain(text);
    for (const text of want.itemXmlExcludes ?? [])
      expect(itemXml).not.toContain(text);
  });
});
