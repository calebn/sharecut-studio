import { describe, expect, it } from "vitest";
import { CHECKS, DRIFTED, PENDING, READY } from "./feedFixture";
import {
  checksSummary,
  colorIndexOf,
  editBlock,
  fixBlock,
  fixLabel,
  markOf,
  needsInput,
  previewEdit,
  readiness,
  readinessTitle,
  readinessTone,
  sortFindings,
  textFact,
  writeLine,
  xmlLines,
} from "./feedLogic";
import type { Finding } from "./feedView";

describe("readiness", () => {
  it("is ready when only optional findings remain", () => {
    expect(readiness(READY)).toEqual({ kind: "ready" });
    expect(readinessTitle({ kind: "ready" })).toBe("Ready to publish");
  });

  it("counts blockers and warnings and leads with the blocker", () => {
    const state = readiness(CHECKS);
    expect(state).toMatchObject({ kind: "open", left: 2, blockers: 1 });
    expect(state.kind === "open" && state.first.key).toBe("item.enclosure.url");
    expect(readinessTitle(state)).toBe("2 things left");
  });

  it("uses the singular for one thing", () => {
    const one = {
      ...PENDING,
      findings: PENDING.findings.filter((f) => f.key !== "item.intro"),
    };
    expect(readinessTitle(readiness(one))).toBe("1 thing left");
  });

  it("is not ready while a pin whose auto value changed stands", () => {
    const state = readiness(DRIFTED);
    expect(state.kind).toBe("check");
    expect(readinessTitle(state)).toBe("Check the notes");
  });
});

describe("sortFindings", () => {
  it("orders blockers, warnings, then info and leaves the input alone", () => {
    const input = [...CHECKS.findings].reverse();
    const before = input.map((f) => f.message);
    expect(sortFindings(input).map((f) => f.severity)).toEqual([
      "blocker",
      "warn",
      "info",
      "info",
      "info",
    ]);
    expect(input.map((f) => f.message)).toEqual(before);
  });
});

describe("writeLine", () => {
  it("offers Write when the file is stale and nothing blocks", () => {
    expect(writeLine({ ...READY, file: "stale" })).toEqual({
      status: "Feed file is out of date.",
      action: "Write",
      writing: false,
      blockedReason: undefined,
    });
  });

  it("offers nothing when the file is current or being written", () => {
    expect(writeLine(READY).action).toBeNull();
    expect(writeLine(READY, "writing")).toMatchObject({
      action: null,
      writing: true,
    });
  });

  it("offers a retry after a failed write", () => {
    expect(writeLine(READY, "failed").action).toBe("Try again");
  });

  it("names the blocker as the reason", () => {
    expect(writeLine(CHECKS).blockedReason).toBe("Fix the blocker first.");
  });
});

describe("marks and fixes", () => {
  it("marks every kind of source with its own words", () => {
    expect(markOf({ kind: "derived", rule: "x" })).toBe("Auto");
    expect(markOf({ kind: "inherited", from: "channel.image" })).toBe(
      "From your show",
    );
    expect(markOf({ kind: "measured", file: "a.wav" })).toBeNull();
    expect(markOf({ kind: "minted", at: "2026-10-23T09:00:00Z" })).toBeNull();
    expect(markOf({ kind: "pinned", by: "agent", drifted: false })).toBe(
      "Agent",
    );
    expect(markOf({ kind: "pinned", by: "guest", drifted: false })).toBe(
      "Guest",
    );
    expect(markOf({ kind: "pinned", by: "person", drifted: false })).toBe(
      "Edited",
    );
  });

  it("looks button words up from the fix and keeps them off the wire", () => {
    const input = { kind: "input", key: "item.enclosure.url" } as const;
    expect(fixLabel(input)).toBe("Add address");
    expect(needsInput(input)).toBe("item.enclosure.url");
    expect(fixLabel({ kind: "command", command: "export_episode" })).toBe(
      "Export episode",
    );
    expect(
      needsInput({
        kind: "edit",
        edit: { op: "set", key: "item.title", value: "x" },
      }),
    ).toBeNull();
    for (const finding of CHECKS.findings as readonly Finding[])
      expect(JSON.stringify(finding)).not.toMatch(/label/);
  });

  it("reads a value of the wrong type as missing", () => {
    expect(textFact(READY.item, "item.duration").source.kind).toBe("pending");
    expect(textFact(READY.item, "item.title").value).toBe(
      "Nobody asked the river",
    );
  });

  it("derives the avatar hue from the name", () => {
    expect(colorIndexOf("Ana Reyes")).toBe(colorIndexOf("Ana Reyes"));
    expect(colorIndexOf("Ana Reyes")).toBeLessThan(8);
  });
});

describe("readiness tone and checks", () => {
  it("is red only for a blocker", () => {
    expect(readinessTone(readiness(CHECKS))).toBe("blocker");
    expect(readinessTone(readiness(DRIFTED))).toBe("warn");
    expect(readinessTone(readiness(READY))).toBe("ok");
    const warnOnly = {
      ...CHECKS,
      findings: CHECKS.findings.filter((f) => f.severity !== "blocker"),
    };
    expect(readinessTone(readiness(warnOnly))).toBe("warn");
  });

  it("counts what to fix, then what to check", () => {
    expect(checksSummary(CHECKS)).toBe("2 to fix");
    expect(checksSummary(DRIFTED)).toBe("1 to check");
    expect(checksSummary(READY)).toBe("All clear");
  });
});

describe("formatting", () => {
  it("splits xml into markup and content", () => {
    expect(xmlLines("<a>hi</a>\n<b/>")).toEqual([
      {
        id: 0,
        segments: [
          { id: 0, text: "<a>", tag: true },
          { id: 1, text: "hi", tag: false },
          { id: 2, text: "</a>", tag: true },
        ],
      },
      { id: 1, segments: [{ id: 0, text: "<b/>", tag: true }] },
    ]);
  });

  it("keeps markup inside CDATA as content, across lines", () => {
    const [one, two] = xmlLines("<d><![CDATA[<p>hi\n</p>]]></d>");
    expect(one.segments.map((s) => [s.text, s.tag])).toEqual([
      ["<d>", true],
      ["<![CDATA[", true],
      ["<p>hi", false],
    ]);
    expect(two.segments.map((s) => [s.text, s.tag])).toEqual([
      ["</p>", false],
      ["]]>", true],
      ["</d>", true],
    ]);
  });
});

describe("what a link may change", () => {
  const set = (key: string, value: string) =>
    ({ op: "set", key, value }) as const;

  it("lets the host change anything", () => {
    expect(
      editBlock("host", set("channel.mediaUrl", "https://x.test/{file}")),
    ).toBeNull();
    expect(
      fixBlock("host", { kind: "command", command: "create_show" }),
    ).toBeNull();
  });

  it("lets an Editor change episode and plain show values", () => {
    expect(editBlock("editor", set("item.title", "A"))).toBeNull();
    expect(editBlock("editor", set("channel.author", "Ana"))).toBeNull();
    expect(
      editBlock("editor", set("channel.person[Ana].role", "host")),
    ).toBeNull();
    expect(editBlock("editor", { op: "unset", key: "item.intro" })).toBeNull();
    expect(
      editBlock(
        "editor",
        set("channel.image", "https://cdn.example.test/a.jpg"),
      ),
    ).toBeNull();
  });

  it("leaves the show, the hosting address and local art with the host", () => {
    for (const edit of [
      set("show", "field-notes"),
      set("channel.mediaUrl", "https://x.test/{file}"),
      set("channel.image", "/Users/ana/cover.jpg"),
      set("guid", "x"),
    ])
      expect(editBlock("editor", edit)).not.toBeNull();
  });

  it("lets a Viewer change nothing", () => {
    expect(editBlock("viewer", set("item.title", "A"))).toBe(
      "This link can read the listing but not change it.",
    );
    expect(
      fixBlock("viewer", { kind: "command", command: "write_feed" }),
    ).not.toBeNull();
  });

  it("lets an Editor write and choose https artwork but not set up the show", () => {
    expect(
      fixBlock("editor", { kind: "command", command: "write_feed" }),
    ).toBeNull();
    expect(
      fixBlock("editor", { kind: "command", command: "choose_art" }),
    ).toBeNull();
    for (const command of [
      "create_show",
      "link_show",
      "export_episode",
    ] as const)
      expect(fixBlock("editor", { kind: "command", command })).toBe(
        "Only the host can change this.",
      );
    expect(
      fixBlock("editor", { kind: "input", key: "channel.mediaUrl" }),
    ).not.toBeNull();
    expect(
      fixBlock("editor", { kind: "input", key: "channel.title" }),
    ).toBeNull();
  });
});

describe("previewEdit", () => {
  const view = {
    item: {},
    channel: {},
  } as unknown as Parameters<typeof previewEdit>[0];

  it("shows a set value as pinned by whoever sent it", () => {
    const next = previewEdit(
      view,
      { op: "set", key: "item.title", value: "A" },
      "guest",
    );
    expect(next.item["item.title"]).toEqual({
      value: "A",
      source: { kind: "pinned", by: "guest", drifted: false },
    });
    expect(
      previewEdit(
        view,
        { op: "set", key: "channel.author", value: "Ana" },
        "person",
      ).channel["channel.author"]?.value,
    ).toBe("Ana");
  });

  it("waits for the service on an unset, a blank, or a key it does not show", () => {
    expect(
      previewEdit(view, { op: "unset", key: "item.title" }, "person"),
    ).toBe(view);
    expect(
      previewEdit(
        view,
        { op: "set", key: "item.title", value: "  " },
        "person",
      ),
    ).toBe(view);
    expect(
      previewEdit(view, { op: "set", key: "show", value: "x" }, "person"),
    ).toBe(view);
  });
});
