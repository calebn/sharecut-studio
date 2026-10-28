import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { MARKER_BODY } from "./liveCommentQueue";
import type { RecordSnapshot } from "./types";
import { useRosterAnnouncer } from "./useRosterAnnouncer";

const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Hana",
});
const me = recordParticipant({ participant_id: "p_g", display_name: "Ava" });
const sam = recordParticipant({ participant_id: "p_s", display_name: "Sam" });
const pat = recordParticipant({
  participant_id: "p_p",
  role: "producer",
  display_name: "Pat",
});

const room = (
  participants = [host, me],
  comments: RecordSnapshot["comments"] = [],
) => recordSnapshot({ participants, comments });

const comment = (id: string, author: string, body: string) => ({
  id,
  take_index: 0,
  recording_ms: 900,
  pressed_wall_ms: 900,
  author,
  body,
});

function setup(snapshot: RecordSnapshot | null, meId: string | null = "p_g") {
  return renderHook(
    (props: { snapshot: RecordSnapshot | null; meId: string | null }) =>
      useRosterAnnouncer(props.snapshot, props.meId),
    { initialProps: { snapshot, meId } },
  );
}

describe("useRosterAnnouncer", () => {
  it("is silent for who is already in the room", () => {
    const { result } = setup(room([host, me, sam]));
    expect(result.current).toBe("");
  });

  it("announces a join and a leave", () => {
    const { result, rerender } = setup(room());
    rerender({ snapshot: room([host, me, sam]), meId: "p_g" });
    expect(result.current).toBe("Sam joined");
    rerender({ snapshot: room([host, me]), meId: "p_g" });
    expect(result.current).toBe("Sam left");
  });

  it("counts a dropped connection and a removal as leaving", () => {
    const { result, rerender } = setup(room([host, me, sam, pat]));
    rerender({
      snapshot: room([host, me, { ...sam, connected: false }, pat]),
      meId: "p_g",
    });
    expect(result.current).toBe("Sam left");
    rerender({
      snapshot: room([
        host,
        me,
        { ...sam, connected: false },
        { ...pat, removed: true },
      ]),
      meId: "p_g",
    });
    expect(result.current).toBe("Pat left");
  });

  it("says every change in one snapshot, and keeps names after someone goes", () => {
    const { result, rerender } = setup(room([host, me, sam]));
    rerender({ snapshot: room([me, pat]), meId: "p_g" });
    expect(result.current).toBe("Pat joined. Hana left. Sam left");
  });

  it("never announces the viewer's own arrival or departure", () => {
    const { result, rerender } = setup(room([host]));
    rerender({ snapshot: room([host, me]), meId: "p_g" });
    expect(result.current).toBe("");
  });

  it("waits for the viewer's identity before taking its baseline", () => {
    const { result, rerender } = setup(room([host, me]), null);
    rerender({ snapshot: room([host, me]), meId: "p_g" });
    rerender({ snapshot: room([host, me, sam]), meId: "p_g" });
    expect(result.current).toBe("Sam joined");
  });

  it("reads what someone else wrote, not how many there are", () => {
    const first = comment("c1", "p_host", "Earlier note");
    const { result, rerender } = setup(room([host, me], [first]));
    expect(result.current).toBe("");
    rerender({
      snapshot: room(
        [host, me],
        [
          first,
          comment("c2", "p_host", "Retake that"),
          comment("c3", "p_g", "Mine"),
        ],
      ),
      meId: "p_g",
    });
    expect(result.current).toBe("Hana: Retake that");
  });

  it("describes a marker rather than reading its placeholder", () => {
    const { result, rerender } = setup(room());
    rerender({
      snapshot: room([host, me], [comment("c1", "p_host", MARKER_BODY)]),
      meId: "p_g",
    });
    expect(result.current).toBe("Hana added a marker");
  });

  it("stays silent without a snapshot", () => {
    const { result } = setup(null);
    expect(result.current).toBe("");
  });
});
