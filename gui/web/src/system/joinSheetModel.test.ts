import { describe, expect, it } from "vitest";
import {
  consentLine,
  DECLINED_TEXT,
  declinedPeek,
  joinFocus,
  joinGuestModel,
  joinHeadline,
  joinProducerModel,
  listenersLine,
  micRow,
} from "./joinSheetModel";

const MAYA = { name: "Maya Okafor", colorIndex: 0 };
const JON = { name: "Jon", colorIndex: 3 };
const ANNEKE = { name: "Anneke de Vries", colorIndex: 1 };
const ROSA = { name: "Rosa Diaz", colorIndex: 4 };

const ready = {
  name: "Jon",
  mic: { status: "ready", input: "MacBook Mic", level: 0.3 },
  headphones: "on",
  headphonesRule: "required",
} as const;

describe("joinHeadline", () => {
  it.each([
    [[], "Join the room"],
    [[MAYA], "Maya is here"],
    [[MAYA, JON], "Maya and Jon are here"],
    [[MAYA, JON, ANNEKE], "Maya, Jon and Anneke are here"],
    [[MAYA, JON, ANNEKE, ROSA], "Maya, Jon and 2 others are here"],
  ])("%j reads %s", (people, text) => {
    expect(joinHeadline(people.map((person) => ({ person })))).toBe(text);
  });
});

describe("listenersLine", () => {
  it("names listeners and says they are not recorded", () => {
    expect(
      listenersLine([
        { person: MAYA, role: "host" },
        { person: ROSA, role: "producer" },
      ]),
    ).toBe("Rosa is listening and won't be recorded");
  });

  it("drops listeners with a blank name", () => {
    expect(
      listenersLine([
        { person: { name: " ", colorIndex: 1 }, role: "producer" },
        { person: ROSA, role: "producer" },
      ]),
    ).toBe("Rosa is listening and won't be recorded");
    expect(
      listenersLine([
        { person: { name: "", colorIndex: 1 }, role: "producer" },
      ]),
    ).toBeNull();
  });

  it("is absent with nobody listening", () => {
    expect(listenersLine([{ person: MAYA, role: "host" }])).toBeNull();
  });
});

describe("consentLine", () => {
  it("names the host's project, or the host when unnamed", () => {
    expect(consentLine("Maya Okafor")).toContain("saves to Maya's project");
    expect(consentLine(" ")).toContain("saves to the host's project");
  });
});

describe("joinGuestModel", () => {
  it("is ready with all three rows done and no reason", () => {
    const model = joinGuestModel(ready);
    expect(model.rows.map((row) => row.state)).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(model.ready).toBe(true);
    expect(model.next).toBeNull();
    expect(model.primary).toEqual({
      label: "Join and record",
      reason: null,
      busy: false,
    });
  });

  it("leaves the name row open for a blank name", () => {
    expect(joinGuestModel({ ...ready, name: "  " }).rows[0].state).toBe(
      "queued",
    );
    expect(joinGuestModel({ ...ready, name: "123" }).rows[0].state).toBe(
      "done",
    );
  });

  it("names the name row first when the name and the mic are both unmet", () => {
    const model = joinGuestModel({
      name: "",
      mic: { status: "idle" },
      headphones: "off",
      headphonesRule: "required",
    });
    expect(model.next).toBe("name");
    expect(model.primary.reason).toBe("Add your name first");
  });

  it("names the first unmet row, in order", () => {
    expect(joinGuestModel({ ...ready, name: "" }).primary.reason).toBe(
      "Add your name first",
    );
    expect(
      joinGuestModel({ ...ready, mic: { status: "idle" }, headphones: "off" })
        .primary.reason,
    ).toBe("Allow your microphone first");
    expect(joinGuestModel({ ...ready, headphones: "off" }).primary.reason).toBe(
      "Put on headphones first",
    );
  });

  it.each([
    ["idle", "queued", "Allow your microphone first", "allow"],
    ["prompting", "running", "Answer your browser first", "allow"],
    ["denied", "needs-you", "Unblock your microphone first", "how-to"],
    ["lost", "failed", "Reconnect your microphone first", "retry"],
  ] as const)("the %s mic is a %s row", (status, state, reason, action) => {
    const model = joinGuestModel({ ...ready, mic: { status } });
    expect(model.rows[1].state).toBe(state);
    expect(model.rows[1].action?.kind).toBe(action);
    expect(model.primary.reason).toBe(reason);
    expect(model.ready).toBe(false);
  });

  it("words the denied and prompting rows", () => {
    expect(
      joinGuestModel({ ...ready, mic: { status: "denied" } }).rows[1].title,
    ).toBe("Microphone blocked");
    expect(
      joinGuestModel({ ...ready, mic: { status: "prompting" } }).rows[1].detail,
    ).toBe("Waiting for your browser…");
  });

  it("shows the input name on a ready mic", () => {
    expect(joinGuestModel(ready).rows[1].detail).toBe("MacBook Mic");
  });

  it("adds the too-loud line while the mic clips, and does not block joining", () => {
    const model = joinGuestModel({
      ...ready,
      mic: { status: "ready", input: "Mic", level: 1, clipped: true },
    });
    expect(model.micNotes.map((note) => note.text)).toEqual([
      "Too loud. Move back a little.",
    ]);
    expect(model.ready).toBe(true);
  });

  it("adds the low-space line, below the clip line", () => {
    const model = joinGuestModel({
      ...ready,
      lowStorage: true,
      mic: { status: "ready", input: "Mic", level: 1, clipped: true },
    });
    expect(model.micNotes.map((note) => note.text)).toEqual([
      "Too loud. Move back a little.",
      "Low space on this device. Close other tabs.",
    ]);
    expect(model.ready).toBe(true);
  });

  it("has no notes by default", () => {
    expect(joinGuestModel(ready).micNotes).toEqual([]);
  });

  it("shows Joining… and no reason while joining", () => {
    expect(joinGuestModel({ ...ready, joining: true }).primary).toEqual({
      label: "Joining…",
      reason: null,
      busy: true,
    });
  });
});

describe("joinProducerModel", () => {
  it("needs only a name", () => {
    expect(joinProducerModel({ name: "" }).primary).toEqual({
      label: "Join to listen",
      reason: "Add your name first",
      busy: false,
    });
    const model = joinProducerModel({ name: "Rosa" });
    expect(model.ready).toBe(true);
    expect(model.primary.reason).toBeNull();
  });

  it("busy while joining", () => {
    expect(
      joinProducerModel({ name: "Rosa", joining: true }).primary.busy,
    ).toBe(true);
  });
});

describe("declinedPeek", () => {
  const { wait, reconnecting } = DECLINED_TEXT.guest;
  it.each([
    [{ kind: "waiting", host: "Maya" }, null],
    [{ kind: "countdown", secondsLeft: 3 }, wait],
    [{ kind: "live", take: 1, clockSec: 5 }, wait],
    [{ kind: "paused", clockSec: 5 }, wait],
    [{ kind: "saving", savedPeople: 1, totalPeople: 2 }, wait],
    [{ kind: "saved" }, wait],
    [{ kind: "reconnecting", paused: false, clockSec: 43 }, reconnecting],
  ] as const)("holds a guest's %j with %s", (phase, reason) => {
    expect(declinedPeek(phase, "guest").disabledReason).toBe(reason);
  });

  it.each([
    { kind: "waiting", host: "Maya" },
    { kind: "countdown", secondsLeft: 3 },
    { kind: "live", take: 1, clockSec: 5 },
    { kind: "paused", clockSec: 5 },
    { kind: "saving", savedPeople: 1, totalPeople: 2 },
    { kind: "saved" },
    { kind: "reconnecting", paused: false, clockSec: 43 },
  ] as const)("never holds a producer's %j", (phase) => {
    expect(declinedPeek(phase, "producer").disabledReason).toBeNull();
  });

  it("says the producer is not in the room, with the way in", () => {
    expect(DECLINED_TEXT.producer).toEqual({
      line: "You're not in the room yet. You won't be recorded.",
      join: "Join to listen",
      label: "Not in the room",
      glyph: "headphones",
    });
  });
});

describe("joinGuestModel blocker and notes", () => {
  it("puts a storage blocker first, before a missing name and mic", () => {
    const model = joinGuestModel({
      name: "",
      mic: { status: "idle" },
      headphones: "off",
      headphonesRule: "required",
      blocker: { text: "Storage is off.", action: { label: "Retry" } },
    });
    expect(model.rows.map((row) => row.key)).toEqual([
      "storage",
      "name",
      "mic",
      "headphones",
    ]);
    expect(model.rows[0]).toMatchObject({
      state: "failed",
      detail: "Storage is off.",
      action: { label: "Retry", name: "Retry", kind: "blocker" },
    });
    expect(model.next).toBe("storage");
    expect(model.ready).toBe(false);
    expect(model.primary.reason).toBe("Fix storage first");
  });

  it("runs a blocker without an action as a check in progress", () => {
    const model = joinGuestModel({
      ...ready,
      blocker: { text: "Checking this device…" },
    });
    expect(model.rows[0]).toMatchObject({ state: "running" });
    expect(model.rows[0].action).toBeUndefined();
    expect(model.primary.reason).toBe("Wait for the storage check first");
  });

  it("adds no row without a blocker", () => {
    expect(joinGuestModel(ready).rows.map((row) => row.key)).toEqual([
      "name",
      "mic",
      "headphones",
    ]);
  });

  it("carries the lost detail onto the mic row", () => {
    const model = joinGuestModel({
      ...ready,
      mic: { status: "lost", detail: "Microphone disconnected." },
    });
    expect(model.rows[1]).toMatchObject({
      state: "failed",
      detail: "Microphone disconnected.",
    });
    expect(model.primary.reason).toBe("Reconnect your microphone first");
  });

  it("lists the caller's notes before too loud and low space", () => {
    const model = joinGuestModel({
      ...ready,
      mic: { ...ready.mic, clipped: true },
      lowStorage: true,
      micNotes: ["Your saved microphone isn't available."],
    });
    expect(model.micNotes.map((note) => note.text)).toEqual([
      "Your saved microphone isn't available.",
      "Too loud. Move back a little.",
      "Low space on this device. Close other tabs.",
    ]);
  });
});

describe("joinGuestModel while the input switches", () => {
  it("holds Join until the picked input opens", () => {
    const model = joinGuestModel({
      name: "Maya",
      headphones: "on",
      headphonesRule: "required",
      mic: { status: "ready", input: "Headset", level: 0, switching: true },
    });
    expect(model.ready).toBe(false);
    expect(model.primary.reason).toBe("Wait for your microphone first");
  });
});

describe("joinFocus", () => {
  it("puts a mouse on a first visit in the name field", () => {
    expect(joinFocus("name", "fine")).toEqual({ kind: "name-field" });
  });

  it("puts a touch screen on the name row, not the field", () => {
    expect(joinFocus("name", "coarse")).toEqual({ kind: "row", step: "name" });
  });

  it("goes to the first unmet row once the name is known", () => {
    expect(joinFocus("mic", "fine")).toEqual({ kind: "row", step: "mic" });
  });

  it("goes to the storage row before the name", () => {
    expect(joinFocus("storage", "fine")).toEqual({
      kind: "row",
      step: "storage",
    });
  });

  it("goes to the primary only when every row is done", () => {
    expect(joinFocus(null, "coarse")).toEqual({ kind: "primary" });
  });
});

describe("micRow while the browser asks", () => {
  it("keeps Allow microphone, busy, while the browser asks", () => {
    expect(micRow({ status: "prompting" })).toEqual({
      key: "mic",
      state: "running",
      title: "Microphone",
      detail: "Waiting for your browser…",
      action: {
        label: "Allow microphone",
        name: "Allow microphone",
        kind: "allow",
        busy: true,
      },
    });
  });
});

describe("joinGuestModel headphones rule", () => {
  const base = {
    name: "Jon",
    mic: { status: "ready", input: "MacBook Mic", level: 0.3 },
  } as const;

  it("asks a phone guest to answer before Join, with no note", () => {
    const model = joinGuestModel({
      ...base,
      headphones: "unset",
      headphonesRule: "choice",
    });
    expect(model.next).toBe("headphones");
    expect(model.ready).toBe(false);
    expect(model.primary.reason).toBe("Say if you're wearing headphones first");
    expect(model.headphonesNote).toBeNull();
  });

  it("lets a phone guest join without headphones and says what that costs", () => {
    const model = joinGuestModel({
      ...base,
      headphones: "off",
      headphonesRule: "choice",
    });
    expect(model.ready).toBe(true);
    expect(model.next).toBeNull();
    expect(model.headphonesNote).toEqual({
      tone: "warning",
      text: "Without headphones, the others may hear an echo and be heard in your recording. Keep your volume low.",
    });
  });

  it("gives a phone guest wearing headphones no note", () => {
    const model = joinGuestModel({
      ...base,
      headphones: "on",
      headphonesRule: "choice",
    });
    expect(model.ready).toBe(true);
    expect(model.headphonesNote).toBeNull();
  });

  it.each(["unset", "off"] as const)(
    "keeps the gate on a laptop that says %s",
    (headphones) => {
      const model = joinGuestModel({
        ...base,
        headphones,
        headphonesRule: "required",
      });
      expect(model.ready).toBe(false);
      expect(model.primary.reason).toBe("Put on headphones first");
      expect(model.headphonesNote).toBeNull();
    },
  );
});
