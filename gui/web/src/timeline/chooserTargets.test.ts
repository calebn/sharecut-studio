import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { chooserTargetsOf } from "./chooserTargets";
import type { HitCandidate } from "./hitCandidates";
import { hitTargetProps, type ResolvedHit } from "./hitTargets";
import { HIT_KIND_NAMES, HIT_KINDS, type HitKind } from "./inputContract";

const fixtures: Element[] = [];

function element(attrs: Record<string, string>, trackId?: string): Element {
  const el = document.createElement("button");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (trackId) {
    const row = document.createElement("div");
    row.className = "lane-row";
    row.dataset.trackId = trackId;
    row.append(el);
    document.body.append(row);
    fixtures.push(row);
  } else {
    document.body.append(el);
    fixtures.push(el);
  }
  return el;
}

function hit(
  kind: HitKind,
  opts: {
    x?: number;
    time?: number;
    selected?: boolean;
    detail?: string;
    track?: string;
  } = {},
): ResolvedHit {
  return {
    element: element(
      hitTargetProps(kind, `${kind}-id`, opts.time ?? 3, {
        detail: opts.detail,
      }),
      opts.track,
    ),
    candidate: {
      kind,
      id: `${kind}-id`,
      x: opts.x ?? 100,
      y: 112,
      distance: 1,
      priority: HIT_KINDS[kind].priority,
      selected: opts.selected ?? false,
    } satisfies HitCandidate,
  };
}

beforeEach(() => {
  useDawStore.setState({
    project: minimalProject({
      tracks: [
        sampleTrack({ id: "a", role: "host" }),
        sampleTrack({ id: "b", role: "guest" }),
        sampleTrack({ id: "m", role: "music" }),
      ],
    }),
  });
});

afterEach(() => {
  for (const el of fixtures.splice(0)) el.remove();
});

describe("chooserTargetsOf", () => {
  it("maps every hit kind to a chooser kind", () => {
    for (const kind of HIT_KIND_NAMES) {
      const [target] = chooserTargetsOf([hit(kind)]);
      expect(target.kind, kind).toBeTruthy();
    }
    const kinds = Object.fromEntries(
      HIT_KIND_NAMES.map((kind) => [
        kind,
        chooserTargetsOf([hit(kind)])[0].kind,
      ]),
    );
    expect(kinds).toMatchObject({
      clip: "clip",
      "trim-in": "clip",
      "fade-out": "clip",
      roll: "seam",
      "pending-start": "suggestion",
      "pending-flag": "suggestion",
      "bleed-attenuation": "suggestion",
      comment: "comment",
      "envelope-point": "envelope-point",
      chapter: "chapter",
      "social-clip": "social-clip",
    });
  });

  it("orders the kept targets left to right by x, ties by priority, and ids by hit index", () => {
    const targets = chooserTargetsOf([
      hit("trim-in", { x: 204 }),
      hit("envelope-point", { x: 200, detail: "0.80" }),
      hit("roll", { x: 204 }),
    ]);
    expect(targets.map((t) => t.id)).toEqual(["1", "2", "0"]);
  });

  it("labels each target by its name and time, leaving out a name that repeats its kind", () => {
    const labels = (...hits: ResolvedHit[]) =>
      chooserTargetsOf(hits).map((t) => t.label);
    expect(labels(hit("trim-in", { time: 3 }))).toEqual([
      "Trim start at 00:03.000",
    ]);
    expect(labels(hit("clip", { time: 3 }))).toEqual(["00:03.000"]);
    expect(labels(hit("chapter", { time: 5 }))).toEqual(["00:05.000"]);
    expect(labels(hit("social-clip", { time: 12 }))).toEqual(["00:12.000"]);
    expect(labels(hit("roll", { time: 10 }))).toEqual(["00:10.000"]);
    expect(labels(hit("bleed-attenuation", { time: 10 }))).toEqual([
      "Automatic audio reduction at 00:10.000",
    ]);
    expect(labels(hit("comment", { time: 10, detail: "Ada" }))).toEqual([
      "Ada at 00:10.000",
    ]);
    expect(labels(hit("comment", { time: 10 }))).toEqual(["00:10.000"]);
    expect(labels(hit("envelope-point", { time: 10, detail: "0.80" }))).toEqual(
      ["0.80× at 00:10.000"],
    );
  });

  it("cuts a long author name so the time stays last", () => {
    const [target] = chooserTargetsOf([
      hit("comment", { time: 5, detail: "Ada Lovelace-Smithson the Third" }),
    ]);
    expect(target.label).toBe("Ada Lovelace-Sm… at 00:05.000");
  });

  it("says which target is selected in its label", () => {
    const targets = chooserTargetsOf([
      hit("trim-in", { selected: true, x: 10 }),
      hit("fade-in", { x: 20 }),
    ]);
    expect(targets.map((t) => t.label)).toEqual([
      "Trim start at 00:03.000, selected",
      "Fade in at 00:03.000",
    ]);
  });

  it("rings a target in its track's colour and a marker-lane target in colour 0", () => {
    const targets = chooserTargetsOf([
      hit("trim-in", { x: 1, track: "a" }),
      hit("trim-out", { x: 2, track: "b" }),
      hit("fade-in", { x: 3, track: "m" }),
      hit("chapter", { x: 4 }),
    ]);
    expect(targets.map((t) => t.trackColorIndex)).toEqual([0, 1, 4, 0]);
  });

  it("keeps all of up to five hits and lists the cut ones after them", () => {
    const hits = Array.from({ length: 7 }, (_, i) =>
      hit(i % 2 ? "trim-in" : "trim-out", { x: 100 - i }),
    );
    const targets = chooserTargetsOf(hits);
    expect(targets).toHaveLength(7);
    expect(new Set(targets.map((t) => t.id)).size).toBe(7);
  });

  it("never cuts the selected target, even as the second of its kind", () => {
    const hits = [
      hit("trim-in", { x: 10 }),
      hit("roll", { x: 20 }),
      hit("pending-start", { x: 30 }),
      hit("comment", { x: 40 }),
      hit("chapter", { x: 50 }),
      hit("social-clip", { x: 60 }),
      hit("trim-out", { x: 70, selected: true }),
    ];
    const targets = chooserTargetsOf(hits);
    expect(targets.slice(0, 5).map((t) => t.id)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "6",
    ]);
    expect(targets.slice(5).map((t) => t.id)).toEqual(["4", "5"]);
  });

  it("keeps a distinct kind that ranks beyond five hits of one kind", () => {
    const hits = [
      ...Array.from({ length: 5 }, (_, i) => hit("trim-in", { x: i * 10 })),
      hit("roll", { x: 100 }),
    ];
    const targets = chooserTargetsOf(hits);
    expect(targets.slice(0, 5).map((t) => t.id)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "5",
    ]);
    expect(targets[5].id).toBe("4");
  });

  it("keeps the five best-ranked when the kinds repeat", () => {
    const hits = Array.from({ length: 6 }, (_, i) =>
      hit("trim-in", { x: i * 10 }),
    );
    const targets = chooserTargetsOf(hits);
    expect(targets.slice(0, 5).map((t) => t.id)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(targets[5].id).toBe("5");
  });
});
