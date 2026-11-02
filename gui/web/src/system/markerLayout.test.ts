import { describe, expect, it } from "vitest";
import { type LaneMarker, layoutMarkers } from "./markerLayout";

const ALL: readonly LaneMarker[] = [
  { kind: "chapter", id: "a", start: 1, title: "Cold open" },
  { kind: "comment", id: "b", start: 9, author: "Maya" },
  { kind: "comment", id: "c", start: 14, end: 19.5, author: "Anneke" },
  { kind: "chapter", id: "d", start: 24, title: "Interview" },
  { kind: "clip", id: "e", start: 30, end: 42, title: "Best joke" },
  { kind: "clip", id: "f", start: 46, end: 55, title: "Tight intro" },
];

const summary = (items: ReturnType<typeof layoutMarkers>) =>
  items.map((item) =>
    item.type === "marker"
      ? [item.marker.id, item.left, item.right, item.reachStart, item.reachEnd]
      : ["stack", item.left, item.right, item.reachStart, item.reachEnd],
  );

describe("layoutMarkers", () => {
  it("leaves a full point-comment target before optional chapter text", () => {
    const items = layoutMarkers(
      [
        {
          kind: "chapter",
          id: "chapter",
          start: 6,
          title: "Independent chapter",
        },
        { kind: "comment", id: "comment", start: 25, author: "Verifier" },
      ],
      0,
      5,
      360,
    );
    const chapter = items.find(
      (item) => item.type === "marker" && item.marker.id === "chapter",
    )!;
    const comment = items.find(
      (item) => item.type === "marker" && item.marker.id === "comment",
    )!;
    expect(
      comment.right - comment.left + comment.reachStart + comment.reachEnd,
    ).toBe(44);
    expect(chapter.right + chapter.reachEnd).toBeLessThanOrEqual(
      comment.left - comment.reachStart,
    );
    expect(chapter.right - chapter.left).toBeGreaterThanOrEqual(44);
  });

  it("uses the real stack ownership before Dee without changing the hidden identities", () => {
    const markers: LaneMarker[] = [
      { kind: "comment", id: "a", start: 5, author: "Ada" },
      { kind: "comment", id: "b", start: 5, author: "Ben" },
      { kind: "comment", id: "c", start: 5, author: "Cy" },
      { kind: "comment", id: "d", start: 20, author: "Dee" },
      { kind: "comment", id: "e", start: 30, author: "Eli" },
    ];
    const sizes = new Map([
      ["b", { count: 2, width: 32.40625, borderStart: 1, borderEnd: 1 }],
    ]);
    const items = layoutMarkers(markers, 0, 304 / 60, 304, undefined, sizes);
    const stack = items.find((item) => item.type === "stack")!;
    const dee = items.find(
      (item) => item.type === "marker" && item.marker.id === "d",
    )!;
    const eli = items.find(
      (item) => item.type === "marker" && item.marker.id === "e",
    )!;
    expect(
      stack.type === "stack" && stack.hidden.map((marker) => marker.id),
    ).toEqual(["b", "c"]);
    expect(dee.right - dee.left + dee.reachStart + dee.reachEnd).toBe(44);
    expect(eli.right - eli.left + eli.reachStart + eli.reachEnd).toBe(44);
    const stackOwnedEnd =
      stack.left + 32.40625 + Math.max(0, stack.reachEnd - 1);
    expect(stackOwnedEnd).toBeLessThanOrEqual(dee.left - dee.reachStart);
    expect(dee.right + dee.reachEnd).toBeLessThanOrEqual(
      eli.left - eli.reachStart,
    );
  });

  it("puts each kind where its drawing sits and reaches half the gap to a neighbour, 14 px at most", () => {
    expect(summary(layoutMarkers(ALL, 0, 6, 360))).toEqual([
      ["a", 6, 22, 3, 12],
      ["b", 46, 62, 12, 11],
      ["c", 84, 117, 11, 13.5],
      ["d", 144, 180, 13.5, 0],
      ["e", 180, 252, 0, 12],
      ["f", 276, 330, 12, 14],
    ]);
  });

  it("cuts a chapter's title off at the next marker, or the end of the lane", () => {
    const chapters = layoutMarkers(ALL, 0, 6, 360).filter(
      (i) => i.type === "marker" && i.marker.kind === "chapter",
    );
    expect(chapters.map((i) => i.type === "marker" && i.titleEnd)).toEqual([
      22, 180,
    ]);
    const last = layoutMarkers([ALL[3] as LaneMarker], 0, 6, 360);
    expect(last[0]).toMatchObject({ left: 144, titleEnd: 360 });
  });

  it("centres a point comment on its time and gives every glyph 16 px", () => {
    const [pin, bar, flag] = layoutMarkers(
      [
        { kind: "comment", id: "p", start: 10, author: "Maya" },
        { kind: "comment", id: "q", start: 20, end: 20.2, author: "Maya" },
        { kind: "clip", id: "r", start: 30, end: 30.1, title: "Tiny" },
      ],
      0,
      10,
      400,
    );
    expect([pin, bar, flag].map((i) => [i?.left, i?.right])).toEqual([
      [92, 108],
      [200, 216],
      [300, 316],
    ]);
  });

  it("folds markers that overlap into the earliest and a +N chip after it", () => {
    const items = layoutMarkers(
      [
        { kind: "comment", id: "p1", start: 10, author: "Maya" },
        { kind: "comment", id: "p2", start: 10.5, author: "Anneke" },
        { kind: "chapter", id: "ch", start: 12, title: "Later" },
        { kind: "clip", id: "far", start: 20, end: 25, title: "Far" },
      ],
      0,
      6,
      360,
    );
    expect(summary(items)).toEqual([
      ["p1", 52, 68, 14, 1],
      ["stack", 70, 110, 1, 5],
      ["far", 120, 150, 5, 14],
    ]);
    const stack = items[1];
    expect(stack?.type === "stack" && stack.hidden.map((m) => m.id)).toEqual([
      "p2",
      "ch",
    ]);
  });

  it("lets the markers inside a long clip stand on its span, and folds only what lands on its start glyph or its chip", () => {
    const nested: LaneMarker[] = [
      { kind: "clip", id: "long", start: 0, end: 50, title: "Long" },
      { kind: "comment", id: "in1", start: 10, author: "A" },
      { kind: "comment", id: "in2", start: 20, author: "B" },
      { kind: "chapter", id: "after", start: 52, title: "After" },
    ];
    expect(summary(layoutMarkers(nested, 0, 6, 400))).toEqual([
      ["long", 0, 300, 0, 6],
      ["in1", 52, 68, 14, 14],
      ["in2", 112, 128, 14, 14],
      ["after", 312, 400, 6, 0],
    ]);
    const folded = layoutMarkers(
      [...nested, { kind: "chapter", id: "glyph", start: 0.5, title: "Glyph" }],
      0,
      6,
      400,
    );
    expect(summary(folded).slice(0, 2)).toEqual([
      ["long", 0, 300, 0, 6],
      ["stack", 18, 58, 1, 14],
    ]);
    expect(folded[0]).toMatchObject({ stacked: true });
    expect(folded[1]?.type === "stack" && folded[1].hidden).toEqual([
      { kind: "chapter", id: "glyph", start: 0.5, title: "Glyph" },
      { kind: "comment", id: "in1", start: 10, author: "A" },
    ]);
  });

  it("unfolds nothing it should not: zoomed in, a marker inside a range still stands when the range starts off screen", () => {
    const nested: LaneMarker[] = [
      { kind: "clip", id: "long", start: 0, end: 50, title: "Long" },
      { kind: "comment", id: "in1", start: 10, author: "A" },
      { kind: "comment", id: "in2", start: 20, author: "B" },
      { kind: "chapter", id: "after", start: 52, title: "After" },
    ];
    const items = layoutMarkers(nested, 9.5, 60, 600);
    expect(summary(items)).toEqual([
      ["long", -512, 1112, 0, 0],
      ["in1", 22, 38, 11, 14],
      ["in2", 622, 638, 14, 0],
    ]);
    expect(items.some((item) => item.type === "stack")).toBe(false);
    expect(items[0]).toMatchObject({ startVisible: false, stacked: false });
  });

  it("keeps a range comment's contained pin apart from the range", () => {
    const items = layoutMarkers(
      [
        { kind: "comment", id: "range", start: 10, end: 40, author: "R" },
        { kind: "comment", id: "pin", start: 25, author: "P" },
      ],
      0,
      6,
      360,
    );
    expect(summary(items)).toEqual([
      ["range", 60, 240, 14, 14],
      ["pin", 142, 158, 14, 14],
    ]);
  });

  it("folds a marker that lands on a bracket's end glyph into the bracket's chip", () => {
    const items = layoutMarkers(
      [
        { kind: "clip", id: "c", start: 10, end: 20, title: "C" },
        { kind: "chapter", id: "end", start: 19.5, title: "End" },
      ],
      0,
      6,
      360,
    );
    expect(summary(items)).toEqual([
      ["c", 60, 120, 14, 14],
      ["stack", 78, 118, 1, 14],
    ]);
    expect(items[0]).toMatchObject({ stacked: true });
  });

  it("draws markers at their time on a lane wider than 1024 px", () => {
    const wide: LaneMarker[] = [
      { kind: "clip", id: "d", start: 120, end: 270, title: "D" },
      { kind: "chapter", id: "a", start: 180, title: "A" },
      { kind: "comment", id: "c", start: 210, author: "C" },
      { kind: "chapter", id: "b", start: 240, title: "B" },
    ];
    expect(summary(layoutMarkers(wide, 0, 6, 1500))).toEqual([
      ["d", 720, 1620, 14, 0],
      ["a", 1080, 1224, 14, 14],
      ["c", 1252, 1268, 14, 14],
      ["b", 1440, 1500, 14, 0],
    ]);
  });

  it("holds a drawing to 512 px past the lane, not to 1024 px, and culls on the true footprint", () => {
    const items = layoutMarkers(
      [
        { kind: "clip", id: "span", start: 100, end: 400, title: "Span" },
        { kind: "comment", id: "edge", start: 255, author: "E" },
        { kind: "comment", id: "gone", start: 270, author: "G" },
        { kind: "chapter", id: "far", start: 3000, title: "Far" },
      ],
      0,
      6,
      1500,
    );
    expect(summary(items)).toEqual([
      ["span", 600, 2012, 14, 0],
      ["edge", 1522, 1538, 14, 0],
    ]);
  });

  it("keeps a marker on its own while it is pinned, wherever it is dragged", () => {
    const markers: LaneMarker[] = [
      { kind: "chapter", id: "x", start: 10, title: "X" },
      { kind: "chapter", id: "y", start: 10.5, title: "Y" },
    ];
    expect(summary(layoutMarkers(markers, 0, 6, 360))).toEqual([
      ["x", 60, 78, 14, 0],
      ["stack", 78, 118, 0, 14],
    ]);
    expect(summary(layoutMarkers(markers, 0, 6, 360, "y"))).toEqual([
      ["x", 60, 76, 14, 14],
      ["y", 63, 360, 14, 0],
    ]);
  });

  it("drops markers far outside the window but keeps the pinned one", () => {
    const markers: LaneMarker[] = [
      { kind: "chapter", id: "gone", start: 500, title: "Gone" },
      { kind: "chapter", id: "near", start: 61, title: "Near" },
      { kind: "chapter", id: "held", start: 700, title: "Held" },
    ];
    expect(
      layoutMarkers(markers, 0, 6, 360, "held").map(
        (i) => i.type === "marker" && i.marker.id,
      ),
    ).toEqual(["near", "held"]);
  });

  it("marks an edge that is off screen so its handle is not drawn", () => {
    const [clip] = layoutMarkers(
      [{ kind: "clip", id: "c", start: 50, end: 400, title: "C" }],
      0,
      6,
      360,
    );
    expect(clip).toMatchObject({
      type: "marker",
      startVisible: true,
      endVisible: false,
    });
  });
});

const effective = (item: ReturnType<typeof layoutMarkers>[number]) => ({
  from: item.left - item.reachStart,
  to: item.right + item.reachEnd,
});

describe("layoutMarkers target reach", () => {
  const kinds: readonly ((id: string, at: number) => LaneMarker)[] = [
    (id, at) => ({ kind: "chapter", id, start: at, title: "Chapter" }),
    (id, at) => ({ kind: "clip", id, start: at, end: at + 1, title: "Clip" }),
    (id, at) => ({ kind: "comment", id, start: at, author: "Pin" }),
    (id, at) => ({
      kind: "comment",
      id,
      start: at,
      end: at + 1,
      author: "Span",
    }),
  ];

  it.each([16, 24, 32])(
    "never lets two mixed neighbours share a hit pixel at a %i px root",
    (root) => {
      for (const first of kinds) {
        for (const second of kinds) {
          for (const gap of [0, 8, 14, 20, 28, 40, 60, 90]) {
            const items = layoutMarkers(
              [first("a", 40), second("b", 40 + gap)],
              0,
              1,
              400,
              undefined,
              undefined,
              root,
            ).filter((item) => item.type === "marker");
            if (items.length < 2) continue;
            const [a, b] = items.map(effective);
            expect(a.to).toBeLessThanOrEqual(b.from + 1e-9);
          }
        }
      }
    },
  );

  it.each([16, 32])(
    "gives a point pin a full touch width whenever its neighbours are far enough at a %i px root",
    (root) => {
      const unit = root / 16;
      const items = layoutMarkers(
        [
          { kind: "chapter", id: "left", start: 20, title: "L" },
          { kind: "comment", id: "pin", start: 200, author: "Pin" },
          { kind: "clip", id: "right", start: 380, end: 390, title: "R" },
        ],
        0,
        1,
        420,
        undefined,
        undefined,
        root,
      );
      const pin = items.find(
        (item) => item.type === "marker" && item.marker.id === "pin",
      )!;
      expect(pin.right - pin.left).toBe(16 * unit);
      expect(effective(pin).to - effective(pin).from).toBe(44 * unit);
    },
  );

  it("shares only the gap between a pin and its mixed neighbours, never more than half of it each", () => {
    for (const root of [16, 32]) {
      for (const gap of [10, 20, 30, 40]) {
        const unit = root / 16;
        const items = layoutMarkers(
          [
            { kind: "clip", id: "clip", start: 100, end: 110, title: "C" },
            {
              kind: "comment",
              id: "pin",
              start: 110 + gap * unit + 8 * unit,
              author: "P",
            },
          ],
          0,
          1,
          400,
          undefined,
          undefined,
          root,
        );
        const [clip, pin] = items;
        expect(pin.reachStart).toBeLessThanOrEqual(
          (pin.left - clip.right) / 2 + 1e-9,
        );
      }
    }
  });
});
