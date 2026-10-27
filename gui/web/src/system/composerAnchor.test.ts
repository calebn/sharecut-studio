import { describe, expect, it } from "vitest";
import {
  type AnchorIntent,
  anchorSpan,
  type ComposerAnchor,
  formatAnchor,
  idleAnchor,
  nextAnchor,
  type Playhead,
} from "./composerAnchor";

const playhead: Playhead = { seconds: 1116.4 };
const withSelection: Playhead = {
  seconds: 1116.4,
  selection: { start: 1000, end: 1005 },
};

const follow: ComposerAnchor = { kind: "follow", seconds: 600 };
const pinned: ComposerAnchor = { kind: "pinned", start: 700 };
const episode: ComposerAnchor = { kind: "episode" };

describe("nextAnchor", () => {
  it.each<[string, ComposerAnchor, AnchorIntent, Playhead, ComposerAnchor]>([
    ["follow + pin", follow, "pin", playhead, { kind: "pinned", start: 600 }],
    ["pinned + pin", pinned, "pin", playhead, pinned],
    ["episode + pin", episode, "pin", playhead, episode],
    [
      "follow + here",
      follow,
      "here",
      playhead,
      { kind: "pinned", start: 1116.4 },
    ],
    [
      "pinned + here",
      pinned,
      "here",
      playhead,
      { kind: "pinned", start: 1116.4 },
    ],
    [
      "episode + here",
      episode,
      "here",
      playhead,
      { kind: "pinned", start: 1116.4 },
    ],
    [
      "follow + here with a selection",
      follow,
      "here",
      withSelection,
      { kind: "pinned", start: 1000, end: 1005 },
    ],
    [
      "pinned + here with a selection",
      pinned,
      "here",
      withSelection,
      { kind: "pinned", start: 1000, end: 1005 },
    ],
    [
      "episode + here with a selection",
      episode,
      "here",
      withSelection,
      { kind: "pinned", start: 1000, end: 1005 },
    ],
    ["follow + episode", follow, "episode", playhead, episode],
    ["pinned + episode", pinned, "episode", playhead, episode],
    ["episode + episode", episode, "episode", playhead, episode],
  ])("%s", (_name, anchor, intent, at, expected) => {
    expect(nextAnchor(anchor, intent, at)).toEqual(expected);
  });

  it("freezes the shown time on pin, whatever the playhead is by then", () => {
    expect(nextAnchor(follow, "pin", { seconds: 9999 })).toEqual({
      kind: "pinned",
      start: 600,
    });
  });

  it("is idempotent", () => {
    const once = nextAnchor(follow, "pin", playhead);
    expect(nextAnchor(once, "pin", playhead)).toEqual(once);
    const here = nextAnchor(follow, "here", withSelection);
    expect(nextAnchor(here, "here", withSelection)).toEqual(here);
  });
});

describe("idleAnchor", () => {
  it("follows the playhead", () => {
    expect(idleAnchor(playhead)).toEqual({ kind: "follow", seconds: 1116.4 });
  });

  it("pins a selection as a range", () => {
    expect(idleAnchor(withSelection)).toEqual({
      kind: "pinned",
      start: 1000,
      end: 1005,
    });
  });
});

describe("anchorSpan", () => {
  it("gives a span for follow and pinned, and none for a whole-episode note", () => {
    expect(anchorSpan(follow)).toEqual({ start: 600 });
    expect(anchorSpan(pinned)).toEqual({ start: 700 });
    expect(anchorSpan({ kind: "pinned", start: 1, end: 3 })).toEqual({
      start: 1,
      end: 3,
    });
    expect(anchorSpan(episode)).toBeUndefined();
  });
});

describe("formatAnchor", () => {
  it("reads as timecode, and as a range with 'to'", () => {
    expect(formatAnchor({ start: 1116 })).toBe("18:36");
    expect(formatAnchor({ start: 1116, end: 1121 })).toBe("18:36 to 18:41");
    expect(formatAnchor({ start: 702.3 })).toBe("11:42");
  });
});
