import { describe, expect, it } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { noteItems } from "./noteItems";

const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Hana",
});
const guest = recordParticipant({ participant_id: "p_g", display_name: "Bo" });

const comment = (id: string, author: string, body: string) => ({
  id,
  take_index: 0,
  recording_ms: 1000,
  pressed_wall_ms: 0,
  author,
  body,
});

describe("noteItems own comments", () => {
  const snapshot = recordSnapshot({
    participants: [host, guest],
    comments: [
      comment("1", "p_host", "Retake this"),
      comment("2", "p_g", "Okay"),
      comment("3", "gone", "Who am I"),
    ],
  });

  it("marks only the viewer's own comments when told who the viewer is", () => {
    expect(noteItems(snapshot, "p_host").map((item) => item.mine)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("guard: leaves mine unset without a viewer id", () => {
    expect(noteItems(snapshot).map((item) => item.mine)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("guard: marks nothing as mine when the viewer is not in the participants", () => {
    const items = noteItems(snapshot, "p_missing");
    expect(items.map((item) => item.mine)).toEqual([false, false, false]);
  });

  it("does not take a guest who shares the host's name for the host", () => {
    const twin = recordParticipant({
      participant_id: "p_twin",
      display_name: "Hana",
    });
    const items = noteItems(
      recordSnapshot({
        participants: [host, twin],
        comments: [comment("1", "p_twin", "Hi")],
      }),
      "p_host",
    );
    expect(items[0]?.mine).toBe(false);
  });
});
