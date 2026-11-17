import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { createElement, Suspense, startTransition, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { MARKER_BODY } from "./liveCommentQueue";
import type { RecordSnapshot } from "./types";
import {
  useLookingInAnnouncer,
  useRosterAnnouncer,
} from "./useRosterAnnouncer";

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

/** The one-minute room-tone round, 50 s left. */
const counting = (snapshot: RecordSnapshot): RecordSnapshot => ({
  ...snapshot,
  room_tone: {
    round: 1,
    requested_wall_ms: 0,
    duration_ms: 60000,
    participant_ids: [],
  },
  countdown_left_ms: 50000,
});

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

  it("retains history and its line through missing snapshots and identity", () => {
    const { result, rerender } = setup(room());
    rerender({ snapshot: room([host, me, sam]), meId: "p_g" });
    expect(result.current).toBe("Sam joined");
    rerender({ snapshot: null, meId: null });
    expect(result.current).toBe("Sam joined");
    rerender({ snapshot: room([host, me, sam, pat]), meId: null });
    expect(result.current).toBe("Sam joined");
    rerender({ snapshot: room([host, me, sam, pat]), meId: "p_g" });
    expect(result.current).toBe("Pat joined");
  });

  it("remembers a silent rename for a later departure", () => {
    const { result, rerender } = setup(room([host, me, sam]));
    rerender({
      snapshot: room([host, me, { ...sam, display_name: "Samuel" }]),
      meId: "p_g",
    });
    expect(result.current).toBe("");
    rerender({ snapshot: room(), meId: "p_g" });
    expect(result.current).toBe("Samuel left");
  });

  it("preserves duplicate new comment rows and then remembers their id", () => {
    const { result, rerender } = setup(room());
    const comments = [
      comment("same", "p_host", "First"),
      comment("same", "p_host", "Second"),
    ];
    rerender({ snapshot: room([host, me], comments), meId: "p_g" });
    expect(result.current).toBe("Hana: First. Hana: Second");
    rerender({ snapshot: room([host, me], comments), meId: "p_g" });
    expect(result.current).toBe("Hana: First. Hana: Second");
    rerender({ snapshot: room([host, me, sam], comments), meId: "p_g" });
    expect(result.current).toBe("Sam joined");
  });

  it("keeps history while changing the viewer identity", () => {
    const snapshot = room([host, me, sam]);
    const { result, rerender } = setup(snapshot);
    rerender({ snapshot, meId: "p_s" });
    expect(result.current).toBe("Ava joined. Sam left");
  });

  it("converges with a fresh value-equal snapshot on each render", () => {
    const { result, rerender } = renderHook(
      ({ joined }) =>
        useRosterAnnouncer(room(joined ? [host, me, sam] : [host, me]), "p_g"),
      { initialProps: { joined: false } },
    );
    expect(result.current).toBe("");
    rerender({ joined: true });
    expect(result.current).toBe("Sam joined");
    rerender({ joined: true });
    expect(result.current).toBe("Sam joined");
  });

  it("does not remember a positively attempted abandoned roster", async () => {
    const baseline = room();
    const attempted = vi.fn();
    const pending = new Promise<never>(() => {});
    function Observation({
      snapshot,
      suspend,
    }: {
      snapshot: RecordSnapshot;
      suspend: boolean;
    }) {
      const line = useRosterAnnouncer(snapshot, "p_g");
      if (suspend) {
        attempted();
        throw pending;
      }
      return createElement("output", null, line || "Silent");
    }
    function Harness() {
      const [input, setInput] = useState({
        snapshot: baseline,
        suspend: false,
      });
      return createElement(
        "div",
        null,
        createElement(
          "button",
          {
            onClick: () =>
              startTransition(() =>
                setInput({ snapshot: room([host, me, sam]), suspend: true }),
              ),
          },
          "Tentative join",
        ),
        createElement(
          "button",
          { onClick: () => setInput({ snapshot: baseline, suspend: false }) },
          "Keep baseline",
        ),
        createElement(
          Suspense,
          { fallback: createElement("p", null, "Pending observation") },
          createElement(Observation, input),
        ),
      );
    }
    render(createElement(Harness));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tentative join" }));
    });
    expect(attempted).toHaveBeenCalled();
    expect(screen.queryByText("Pending observation")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep baseline" }));
    expect(screen.getByRole("status")).toHaveTextContent("Silent");
  });

  it("stays silent without a snapshot", () => {
    const { result } = setup(null);
    expect(result.current).toBe("");
  });
  describe("someone looking in", () => {
    const LINE = "Someone with the producer link is looking in";
    const at = (
      watchers: number | undefined,
      state: RecordSnapshot["state"] = "lobby",
      session_id = "room1",
    ) =>
      recordSnapshot({
        participants: [host, me],
        watchers,
        state,
        session_id,
      });

    it("announces the first rise from none in the lobby, once", () => {
      const { result, rerender } = setup(at(0));
      rerender({ snapshot: at(1), meId: "p_g" });
      expect(result.current).toBe(LINE);
      rerender({ snapshot: at(0), meId: "p_g" });
      expect(result.current).toBe(LINE);
      rerender({ snapshot: at(2), meId: "p_g" });
      expect(result.current).toBe(LINE);
    });

    it("announces a rise in a stopped room, and from a server that sends no count", () => {
      const { result, rerender } = setup(at(undefined, "stopped"));
      rerender({ snapshot: at(3, "stopped"), meId: "p_g" });
      expect(result.current).toBe(
        "3 people with the producer link are looking in",
      );
    });

    it("is silent about who is already looking in on first render", () => {
      const { result, rerender } = setup(at(1));
      expect(result.current).toBe("");
      rerender({ snapshot: at(2), meId: "p_g" });
      expect(result.current).toBe("");
    });

    it("stays silent while recording or paused", () => {
      const { result, rerender } = setup(at(0, "recording"));
      rerender({ snapshot: at(1, "recording"), meId: "p_g" });
      expect(result.current).toBe("");
      rerender({ snapshot: at(0, "paused"), meId: "p_g" });
      rerender({ snapshot: at(1, "paused"), meId: "p_g" });
      expect(result.current).toBe("");
    });

    it("holds an arrival during the room-tone countdown and speaks it when the countdown ends", () => {
      const { result, rerender } = setup(at(0));
      rerender({ snapshot: counting(at(1)), meId: "p_g" });
      expect(result.current).toBe("");
      rerender({ snapshot: counting(at(1)), meId: "p_g" });
      expect(result.current).toBe("");
      rerender({ snapshot: at(1), meId: "p_g" });
      expect(result.current).toBe(LINE);
    });

    it("stays silent on a leave and on a change from one to more", () => {
      const { result, rerender } = setup(at(0));
      rerender({ snapshot: at(1), meId: "p_g" });
      rerender({ snapshot: at(2), meId: "p_g" });
      rerender({ snapshot: at(1), meId: "p_g" });
      rerender({ snapshot: at(0), meId: "p_g" });
      expect(result.current).toBe(LINE);
    });

    it("announces a lobby rise after a rise that was seen during a take", () => {
      const { result, rerender } = setup(at(0, "recording"));
      rerender({ snapshot: at(1, "recording"), meId: "p_g" });
      expect(result.current).toBe("");
      rerender({ snapshot: at(0, "lobby"), meId: "p_g" });
      rerender({ snapshot: at(1, "lobby"), meId: "p_g" });
      expect(result.current).toBe(LINE);
    });

    it.each([-1, 2.5, 100, Number.NaN, "2"])(
      "is silent for a count that is not a count: %s",
      (bad) => {
        const { result, rerender } = setup(at(0));
        rerender({
          snapshot: at(bad as unknown as number),
          meId: "p_g",
        });
        expect(result.current).toBe("");
      },
    );

    it("announces again for a new room, not for a second rise in the same one", () => {
      const { result, rerender } = setup(at(0));
      rerender({ snapshot: at(1), meId: "p_g" });
      rerender({ snapshot: at(0), meId: "p_g" });
      rerender({ snapshot: at(2), meId: "p_g" });
      expect(result.current).toBe(LINE);
      rerender({ snapshot: at(0, "lobby", "room2"), meId: "p_g" });
      rerender({ snapshot: at(3, "lobby", "room2"), meId: "p_g" });
      expect(result.current).toBe(
        "3 people with the producer link are looking in",
      );
    });
  });
});

describe("useLookingInAnnouncer", () => {
  const LINE = "Someone with the producer link is looking in";
  const at = (
    watchers: number,
    state: RecordSnapshot["state"] = "lobby",
    session_id = "room1",
  ) => recordSnapshot({ watchers, state, session_id });
  const setupHost = (snapshot: RecordSnapshot | null) =>
    renderHook(({ snapshot }) => useLookingInAnnouncer(snapshot), {
      initialProps: { snapshot },
    });

  it("is silent without a snapshot and about who is already looking in", () => {
    const { result, rerender } = setupHost(null);
    expect(result.current).toBe("");
    rerender({ snapshot: at(1) });
    expect(result.current).toBe("");
    rerender({ snapshot: at(2) });
    expect(result.current).toBe("");
  });

  it("announces the first rise in the lobby, once, and says nothing about people", () => {
    const { result, rerender } = setupHost(at(0));
    rerender({ snapshot: at(1) });
    expect(result.current).toBe(LINE);
    rerender({ snapshot: at(0) });
    expect(result.current).toBe("");
    rerender({ snapshot: at(3) });
    expect(result.current).toBe("");
  });

  it("announces the first arrival in each room, even when the words repeat, and clears the note between", () => {
    const { result, rerender } = setupHost(at(0));
    rerender({ snapshot: at(1) });
    expect(result.current).toBe(LINE);
    rerender({ snapshot: at(0) });
    expect(result.current).toBe("");
    rerender({ snapshot: at(0, "lobby", "room2") });
    expect(result.current).toBe("");
    rerender({ snapshot: at(1, "lobby", "room2") });
    expect(result.current).toBe(LINE);
  });

  it("announces a new room's arrival when the last room ended with someone looking in", () => {
    const { result, rerender } = setupHost(at(0));
    rerender({ snapshot: at(1) });
    rerender({ snapshot: at(1, "lobby", "room2") });
    expect(result.current).toBe(LINE);
    rerender({ snapshot: at(2, "recording", "room3") });
    expect(result.current).toBe("");
  });

  it("holds an arrival during the room-tone countdown and speaks it when the countdown ends", () => {
    const { result, rerender } = setupHost(at(0));
    rerender({ snapshot: counting(at(1)) });
    expect(result.current).toBe("");
    rerender({ snapshot: at(1) });
    expect(result.current).toBe(LINE);
  });

  it("holds its tongue during a take, then announces a lobby rise", () => {
    const { result, rerender } = setupHost(at(0, "recording"));
    rerender({ snapshot: at(1, "recording") });
    expect(result.current).toBe("");
    rerender({ snapshot: at(0, "lobby") });
    rerender({ snapshot: at(2, "lobby") });
    expect(result.current).toBe(
      "2 people with the producer link are looking in",
    );
  });

  it("ignores a count that is not a count", () => {
    const { result, rerender } = setupHost(at(0));
    rerender({ snapshot: at(2.5) });
    rerender({ snapshot: at(-3) });
    expect(result.current).toBe("");
  });
});
