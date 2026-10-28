import { describe, expect, it } from "vitest";
import {
  consentLine,
  DECLINED_TEXT,
  declinedPeek,
  joinGuestModel,
  joinHeadline,
  joinProducerModel,
  listenersLine,
} from "./joinSheetModel";

const MAYA = { name: "Maya Okafor", colorIndex: 0 };
const JON = { name: "Jon", colorIndex: 3 };
const ANNEKE = { name: "Anneke de Vries", colorIndex: 1 };
const ROSA = { name: "Rosa Diaz", colorIndex: 4 };

const ready = {
  name: "Jon",
  mic: { status: "ready", input: "MacBook Mic", level: 0.3 },
  headphones: true,
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
      headphones: false,
    });
    expect(model.next).toBe("name");
    expect(model.primary.reason).toBe("Add your name first");
  });

  it("names the first unmet row, in order", () => {
    expect(joinGuestModel({ ...ready, name: "" }).primary.reason).toBe(
      "Add your name first",
    );
    expect(
      joinGuestModel({ ...ready, mic: { status: "idle" }, headphones: false })
        .primary.reason,
    ).toBe("Allow your microphone first");
    expect(joinGuestModel({ ...ready, headphones: false }).primary.reason).toBe(
      "Put on headphones first",
    );
  });

  it.each([
    ["idle", "queued", "Allow your microphone first", "allow"],
    ["prompting", "running", "Answer your browser first", undefined],
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
  it.each([
    [{ kind: "waiting", host: "Maya" }, null],
    [{ kind: "countdown", secondsLeft: 3 }, DECLINED_TEXT.wait],
    [{ kind: "live", take: 1, clockSec: 5 }, DECLINED_TEXT.wait],
    [{ kind: "paused", clockSec: 5 }, DECLINED_TEXT.wait],
    [{ kind: "saving", savedPeople: 1, totalPeople: 2 }, DECLINED_TEXT.wait],
    [{ kind: "saved" }, DECLINED_TEXT.wait],
    [{ kind: "reconnecting" }, DECLINED_TEXT.reconnecting],
  ] as const)("%j gives %s", (phase, reason) => {
    expect(declinedPeek(phase).disabledReason).toBe(reason);
  });
});

describe("joinGuestModel blocker and notes", () => {
  it("puts a storage blocker first, before a missing name and mic", () => {
    const model = joinGuestModel({
      name: "",
      mic: { status: "idle" },
      headphones: false,
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
