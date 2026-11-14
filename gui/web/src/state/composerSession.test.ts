import { describe, expect, it } from "vitest";
import {
  type ComposerEvent,
  type ComposerSession,
  commentDraftOf,
  initialSession,
  reduceComposer,
} from "./composerSession";

const at = (startSec: number) => ({ startSec, endSec: null });
const draft = (text: string, startSec = 5, resume = false, typed = false) => ({
  text,
  anchor: at(startSec),
  resume,
  typed,
});

function session(over: Partial<ComposerSession> = {}): ComposerSession {
  return { ...initialSession, ...over };
}

/** Runs the events in order, collecting every effect. */
function run(
  start: ComposerSession,
  steps: [ComposerEvent, { playing?: boolean }?][],
) {
  let state = start;
  const effects: string[] = [];
  for (const [event, ctx] of steps) {
    const out = reduceComposer(state, event, {
      playing: ctx?.playing ?? false,
    });
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

describe("open outside the phone Listen layout", () => {
  it("leaves a playing episode playing and promises nothing", () => {
    const { state, effects } = run(session(), [
      [
        { type: "open", anchor: at(7), replacePin: false, listen: false },
        { playing: true },
      ],
    ]);
    expect(effects).toEqual([]);
    expect(state.draft).toMatchObject({ resume: false, anchor: at(7) });
    expect(state.pausing).toBe(false);
  });

  it("gives the new anchor the pin even where text was typed", () => {
    const { state } = run(
      session({
        surface: "composer",
        draft: { text: "typed", anchor: at(5), resume: false, typed: false },
      }),
      [[{ type: "open", anchor: at(40), replacePin: false, listen: false }]],
    );
    expect(state.draft).toMatchObject({ text: "typed", anchor: at(40) });
  });
});

describe("open", () => {
  it("pauses a playing episode and promises to play it on", () => {
    const { state, effects } = run(session(), [
      [
        { type: "open", anchor: at(7), replacePin: false, listen: true },
        { playing: true },
      ],
    ]);
    expect(effects).toEqual(["pause"]);
    expect(state.surface).toBe("composer");
    expect(state.draft).toMatchObject({
      resume: true,
      anchor: at(7),
      text: "",
    });
  });

  it("leaves a paused episode alone and promises nothing", () => {
    const { state, effects } = run(session(), [
      [{ type: "open", anchor: at(7), replacePin: false, listen: true }],
    ]);
    expect(effects).toEqual([]);
    expect(state.draft?.resume).toBe(false);
  });

  it("keeps a resume that is already promised when opened again while paused", () => {
    const { state, effects } = run(
      session({ surface: "composer", draft: draft("", 5, true) }),
      [[{ type: "open", anchor: at(9), replacePin: false, listen: true }]],
    );
    expect(effects).toEqual([]);
    expect(state.draft?.resume).toBe(true);
  });

  it("keeps a resume that is already promised when opened again while playing", () => {
    const { state } = run(
      session({ surface: "composer", draft: draft("", 5, true) }),
      [
        [
          { type: "open", anchor: at(9), replacePin: false, listen: true },
          { playing: true },
        ],
      ],
    );
    expect(state.draft?.resume).toBe(true);
  });

  it("keeps the pin of a draft that still has text", () => {
    const { state } = run(session({ draft: draft("too loud", 5) }), [
      [{ type: "open", anchor: at(40), replacePin: false, listen: true }],
    ]);
    expect(state.draft).toMatchObject({ text: "too loud", anchor: at(5) });
  });

  it("pins an empty draft again", () => {
    const { state } = run(session({ draft: draft("", 5) }), [
      [{ type: "open", anchor: at(40), replacePin: false, listen: true }],
    ]);
    expect(state.draft?.anchor).toEqual(at(40));
  });

  it("takes the pin of an explicit anchor even over text", () => {
    const { state } = run(session({ draft: draft("too loud", 5) }), [
      [{ type: "open", anchor: at(40), replacePin: true, listen: true }],
    ]);
    expect(state.draft).toMatchObject({ text: "too loud", anchor: at(40) });
  });

  it("closes a sheet that was open", () => {
    const { state } = run(session({ surface: "thread", threadId: "c1" }), [
      [{ type: "open", anchor: at(7), replacePin: false, listen: true }],
    ]);
    expect(state.surface).toBe("composer");
    expect(state.threadId).toBeNull();
  });
});

describe("transport", () => {
  const open = session({ surface: "composer", draft: draft("hi", 5, true) });

  it("drops the resume on a Play", () => {
    expect(
      run(open, [[{ type: "transport", playing: true }]]).state.draft?.resume,
    ).toBe(false);
  });

  it("drops the resume on a Pause or the end of the episode", () => {
    expect(
      run(open, [[{ type: "transport", playing: false }]]).state.draft?.resume,
    ).toBe(false);
  });

  it("does not take the composer's own pause for the guest's", () => {
    const { state } = run(session(), [
      [
        { type: "open", anchor: at(5), replacePin: false, listen: true },
        { playing: true },
      ],
      [{ type: "transport", playing: false }],
    ]);
    expect(state.draft?.resume).toBe(true);
  });

  it("takes the next one for the guest's", () => {
    const { state } = run(session(), [
      [
        { type: "open", anchor: at(5), replacePin: false, listen: true },
        { playing: true },
      ],
      [{ type: "transport", playing: false }],
      [{ type: "transport", playing: true }],
    ]);
    expect(state.draft?.resume).toBe(false);
  });

  it("changes nothing with no draft", () => {
    expect(
      run(session(), [[{ type: "transport", playing: true }]]).state,
    ).toEqual(initialSession);
  });
});

describe("close", () => {
  it("plays on what the composer paused, and keeps the text and its pin", () => {
    const { state, effects } = run(
      session({ surface: "composer", draft: draft("note", 5, true) }),
      [[{ type: "close" }]],
    );
    expect(effects).toEqual(["play"]);
    expect(state.surface).toBe("none");
    expect(state.draft).toMatchObject({
      text: "note",
      anchor: at(5),
      resume: false,
    });
  });

  it("does not play on after the guest paused on purpose", () => {
    const { effects } = run(
      session({ surface: "composer", draft: draft("note", 5, true) }),
      [[{ type: "transport", playing: true }], [{ type: "close" }]],
    );
    expect(effects).toEqual([]);
  });

  it("does not play what is already playing", () => {
    const { effects } = run(
      session({ surface: "composer", draft: draft("", 5, true) }),
      [[{ type: "close" }, { playing: true }]],
    );
    expect(effects).toEqual([]);
  });

  it("drops an empty draft", () => {
    expect(
      run(session({ surface: "composer", draft: draft("") }), [
        [{ type: "close" }],
      ]).state.draft,
    ).toBeNull();
  });

  it("discard drops the text too", () => {
    const { state, effects } = run(
      session({ surface: "composer", draft: draft("note", 5, true) }),
      [[{ type: "discard" }]],
    );
    expect(effects).toEqual(["play"]);
    expect(state.draft).toBeNull();
  });

  it("plays on once, however many times it is closed", () => {
    const { effects } = run(
      session({ surface: "composer", draft: draft("note", 5, true) }),
      [[{ type: "close" }], [{ type: "close" }]],
    );
    expect(effects).toEqual(["play"]);
  });
});

describe("type", () => {
  it("makes a draft at the fresh anchor on the first character", () => {
    const { state } = run(session(), [
      [{ type: "type", text: "a", fresh: at(12) }],
    ]);
    expect(state.draft).toMatchObject({
      text: "a",
      anchor: at(12),
      typed: true,
    });
    expect(state.surface).toBe("composer");
  });

  it("keeps text typed while no anchor can be known, and pins on the next keystroke that resolves", () => {
    const first = run(session(), [[{ type: "type", text: "a", fresh: null }]]);
    expect(first.state.draft).toMatchObject({ text: "a", anchor: null });
    expect(commentDraftOf(first.state)).toBeNull();
    const still = run(first.state, [
      [{ type: "type", text: "ab", fresh: null }],
    ]);
    expect(still.state.draft).toMatchObject({ text: "ab", anchor: null });
    const pinned = run(still.state, [
      [{ type: "type", text: "abc", fresh: at(12) }],
    ]);
    expect(pinned.state.draft).toMatchObject({ text: "abc", anchor: at(12) });
    // a pinned draft keeps its pin
    const kept = run(pinned.state, [
      [{ type: "type", text: "abcd", fresh: at(30) }],
    ]);
    expect(kept.state.draft?.anchor).toEqual(at(12));
  });

  it("drops a typed draft when it is emptied, and brings it back on undo", () => {
    const { state } = run(session(), [
      [{ type: "type", text: "a", fresh: at(12) }],
      [{ type: "type", text: "", fresh: at(30) }],
      [{ type: "type", text: "a", fresh: at(30), undo: true }],
    ]);
    expect(state.draft?.anchor).toEqual(at(12));
  });

  it("keeps a typed draft while an IME composes", () => {
    const { state } = run(session(), [
      [{ type: "type", text: "a", fresh: at(12) }],
      [{ type: "type", text: "", fresh: at(30), composing: true }],
    ]);
    expect(state.draft).not.toBeNull();
  });

  it("keeps an opened draft when it is emptied", () => {
    const { state } = run(session(), [
      [{ type: "open", anchor: at(7), replacePin: false, listen: true }],
      [{ type: "type", text: "a", fresh: at(30) }],
      [{ type: "type", text: "", fresh: at(30) }],
    ]);
    expect(state.draft).toMatchObject({ text: "", anchor: at(7) });
  });
});

describe("post", () => {
  const typed = session({
    surface: "composer",
    draft: draft("hello", 5, true),
  });

  it("remembers the text it sent", () => {
    const { state } = run(typed, [[{ type: "postStart", id: 1 }]]);
    expect(state.post).toEqual({ id: 1, sentText: "hello" });
  });

  it("sends one at a time", () => {
    const { state } = run(typed, [
      [{ type: "postStart", id: 1 }],
      [{ type: "postStart", id: 2 }],
    ]);
    expect(state.post?.id).toBe(1);
  });

  it("clears the draft and plays on when it lands", () => {
    const { state, effects } = run(typed, [
      [{ type: "postStart", id: 1 }],
      [{ type: "postDone", id: 1 }],
    ]);
    expect(state.draft).toBeNull();
    expect(state.surface).toBe("none");
    expect(state.post).toBeNull();
    expect(effects).toEqual(["play"]);
  });

  it("does not play on after a Play then a Pause while it was in flight", () => {
    const { effects } = run(typed, [
      [{ type: "postStart", id: 1 }],
      [{ type: "transport", playing: true }],
      [{ type: "transport", playing: false }],
      [{ type: "postDone", id: 1 }],
    ]);
    expect(effects).toEqual([]);
  });

  it("plays on once after a Close during the post, not twice", () => {
    const { state, effects } = run(typed, [
      [{ type: "postStart", id: 1 }],
      [{ type: "close" }],
      [{ type: "postDone", id: 1 }],
    ]);
    expect(effects).toEqual(["play"]);
    expect(state.draft).toBeNull();
  });

  it("keeps text typed after a Close and a reopen, and its pin", () => {
    const { state, effects } = run(typed, [
      [{ type: "postStart", id: 1 }],
      [{ type: "close" }],
      [{ type: "open", anchor: at(40), replacePin: false, listen: true }],
      [{ type: "type", text: "hello and more", fresh: at(40) }],
      [{ type: "postDone", id: 1 }],
    ]);
    expect(effects).toEqual(["play"]);
    expect(state.surface).toBe("composer");
    expect(state.draft).toMatchObject({
      text: "hello and more",
      anchor: at(5),
    });
  });

  it("keeps an unrelated pin when the text differs", () => {
    const { state } = run(
      session({ surface: "composer", draft: draft("hello", 5) }),
      [
        [{ type: "postStart", id: 1 }],
        [{ type: "type", text: "other", fresh: at(40) }],
        [{ type: "postDone", id: 1 }],
      ],
    );
    expect(state.draft).toMatchObject({ text: "other", anchor: at(5) });
  });

  it("ignores a second landing", () => {
    const { effects } = run(typed, [
      [{ type: "postStart", id: 1 }],
      [{ type: "postDone", id: 1 }],
      [{ type: "postDone", id: 1 }],
    ]);
    expect(effects).toEqual(["play"]);
  });

  it("ignores a landing for another id", () => {
    const { state, effects } = run(typed, [
      [{ type: "postStart", id: 2 }],
      [{ type: "postDone", id: 1 }],
    ]);
    expect(effects).toEqual([]);
    expect(state.post?.id).toBe(2);
    expect(state.draft?.text).toBe("hello");
  });

  it("keeps text, pin and resume when it fails", () => {
    const { state, effects } = run(typed, [
      [{ type: "postStart", id: 1 }],
      [{ type: "postFailed", id: 1 }],
    ]);
    expect(effects).toEqual([]);
    expect(state.post).toBeNull();
    expect(state.draft).toMatchObject({
      text: "hello",
      anchor: at(5),
      resume: true,
    });
    expect(state.surface).toBe("composer");
  });

  it("ignores a failure for another id", () => {
    const { state } = run(typed, [
      [{ type: "postStart", id: 2 }],
      [{ type: "postFailed", id: 1 }],
    ]);
    expect(state.post?.id).toBe(2);
  });
});

describe("show", () => {
  it("leaving the composer for a sheet closes it, and plays on", () => {
    const { state, effects } = run(
      session({ surface: "composer", draft: draft("note", 5, true) }),
      [[{ type: "show", surface: "chapters" }]],
    );
    expect(effects).toEqual(["play"]);
    expect(state.surface).toBe("chapters");
    expect(state.draft).toMatchObject({ text: "note", resume: false });
  });

  it("one surface at a time, and a thread remembers which", () => {
    const { state } = run(session(), [
      [{ type: "show", surface: "comments" }],
      [{ type: "show", surface: "thread", threadId: "c2" }],
    ]);
    expect(state).toMatchObject({ surface: "thread", threadId: "c2" });
    expect(
      run(state, [[{ type: "show", surface: "none" }]]).state,
    ).toMatchObject({ surface: "none", threadId: null });
  });

  it("sheetsGone closes a sheet and leaves the composer", () => {
    expect(
      run(session({ surface: "thread", threadId: "c1" }), [
        [{ type: "sheetsGone" }],
      ]).state.surface,
    ).toBe("none");
    expect(
      run(session({ surface: "composer", draft: draft("a") }), [
        [{ type: "sheetsGone" }],
      ]).state.surface,
    ).toBe("composer");
  });

  it("sheetsGone makes a held draft with text the open composer at its own pin, and starts nothing", () => {
    for (const surface of ["none", "comments", "thread", "chapters"] as const) {
      const converted = run(session({ surface, draft: draft("too loud", 5) }), [
        [{ type: "sheetsGone" }],
      ]);
      expect(converted.state.surface).toBe("composer");
      expect(converted.state.draft).toEqual(draft("too loud", 5));
      expect(converted.state.draft?.resume).toBe(false);
      expect(commentDraftOf(converted.state)).toEqual(at(5));
      expect(converted.effects).toEqual([]);
      const { state, effects } = run(converted.state, [
        [{ type: "transport", playing: true }],
      ]);
      expect(state.draft).toEqual(draft("too loud", 5));
      expect(effects).toEqual([]);
    }
  });

  it("sheetsGone puts no pin on a closed empty draft, and rotating back keeps the pin", () => {
    const closed = run(
      session({ surface: "composer", draft: draft("", 5, false, false) }),
      [[{ type: "close" }], [{ type: "sheetsGone" }]],
    ).state;
    expect(closed.surface).toBe("none");
    expect(commentDraftOf(closed)).toBeNull();
    const back = run(
      session({ surface: "none", draft: draft("too loud", 5) }),
      [
        [{ type: "sheetsGone" }],
        [{ type: "open", anchor: at(40), replacePin: false, listen: true }],
      ],
    ).state;
    expect(back.draft?.anchor).toEqual(at(5));
  });
});

describe("reset: the guest may no longer comment", () => {
  it("clears everything and leaves a playing episode alone", () => {
    const { state, effects } = run(
      session({
        surface: "composer",
        draft: draft("a", 5, false),
        post: { id: 1, sentText: "a" },
      }),
      [[{ type: "reset" }, { playing: true }]],
    );
    expect(state).toEqual(initialSession);
    expect(effects).toEqual([]);
  });

  it("plays on what the composer paused, as Close does", () => {
    const { state, effects } = run(
      session({
        surface: "composer",
        draft: draft("a", 5, true),
        post: { id: 1, sentText: "a" },
      }),
      [[{ type: "reset" }]],
    );
    expect(state).toEqual(initialSession);
    expect(effects).toEqual(["play"]);
  });

  it("plays on from a held draft with the field closed", () => {
    const { state, effects } = run(session({ draft: draft("a", 5, true) }), [
      [{ type: "reset" }],
    ]);
    expect(state).toEqual(initialSession);
    expect(effects).toEqual(["play"]);
  });

  it("leaves a paused episode the listener paused alone", () => {
    const { effects } = run(
      session({ surface: "composer", draft: draft("a", 5, false) }),
      [[{ type: "reset" }]],
    );
    expect(effects).toEqual([]);
  });
});

describe("open with listen false keeps a held pause", () => {
  const held = session({ surface: "composer", draft: draft("a", 5, true) });

  it("keeps resume, never pauses, and replaces the pin", () => {
    const { state, effects } = run(held, [
      [{ type: "open", anchor: at(40), replacePin: true, listen: false }],
    ]);
    expect(effects).toEqual([]);
    expect(state.draft).toMatchObject({
      text: "a",
      anchor: at(40),
      resume: true,
    });
    expect(state.pausing).toBe(false);
  });

  it("plays on at Post after the layout stopped being Listen", () => {
    const { effects } = run(held, [
      [{ type: "open", anchor: at(40), replacePin: true, listen: false }],
      [{ type: "postStart", id: 1 }],
      [{ type: "postDone", id: 1 }],
    ]);
    expect(effects).toEqual(["play"]);
  });

  it("plays on at Close and at discard", () => {
    for (const type of ["close", "discard"] as const) {
      const { effects } = run(held, [
        [{ type: "open", anchor: at(40), replacePin: true, listen: false }],
        [{ type }],
      ]);
      expect(effects).toEqual(["play"]);
    }
  });

  it("does not invent a promise where none was held", () => {
    const { state } = run(
      session({ surface: "composer", draft: draft("a", 5, false) }),
      [[{ type: "open", anchor: at(40), replacePin: true, listen: false }]],
    );
    expect(state.draft?.resume).toBe(false);
  });
});

describe("commentDraftOf", () => {
  it("shows the anchor only while the composer is open", () => {
    expect(
      commentDraftOf(session({ surface: "composer", draft: draft("a", 5) })),
    ).toEqual(at(5));
    expect(commentDraftOf(session({ draft: draft("a", 5) }))).toBeNull();
    expect(commentDraftOf(initialSession)).toBeNull();
  });
});
