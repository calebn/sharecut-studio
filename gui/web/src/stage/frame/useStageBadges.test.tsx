import { act, renderHook } from "@testing-library/react";
import { type ReactNode, useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRoom } from "../../record";
import { HostRoomProvider } from "../../record/hostRoomContext";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, pendingEditView } from "../../test/fixtures";
import { useRecordBadge, useStageBadges } from "./useStageBadges";

const room = (micLossNeedsAttention: boolean) =>
  ({
    micLossNeedsAttention,
    captureUnavailable: false,
    noAudioNeedsAttention: false,
  }) as HostRoom;

const wrap =
  (value: HostRoom) =>
  ({ children }: { children: ReactNode }) => (
    <HostRoomProvider value={value}>{children}</HostRoomProvider>
  );

describe("useStageBadges mic loss", () => {
  beforeEach(() => {
    useDawStore.setState({ stage: "edit", statusAnnouncement: "" });
  });

  it("badges Record and announces once when the mic stops on another stage", () => {
    const { result, rerender } = renderHook(() => useStageBadges(), {
      wrapper: wrap(room(true)),
    });
    expect(result.current.record).toEqual({ kind: "failed" });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Your mic stopped. Open Record to reconnect it.",
    );
    useDawStore.setState({ statusAnnouncement: "" });
    rerender();
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });

  it("stays quiet on the Record stage", () => {
    useDawStore.setState({ stage: "record" });
    const { result } = renderHook(() => useStageBadges(), {
      wrapper: wrap(room(true)),
    });
    expect(result.current.record).toBeUndefined();
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });
});

describe("useRecordBadge", () => {
  beforeEach(() => {
    useDawStore.setState({ stage: "edit" });
  });

  it("re-renders its reader only when the badge changes", () => {
    const renders = vi.fn();
    const waiting = (extra: object = {}) =>
      ({
        snapshot: {
          session_id: "s1",
          state: "lobby",
          take_index: -1,
          participants: [
            {
              participant_id: "a",
              role: "guest",
              display_name: "a",
              connected: true,
              consented: null,
            },
          ],
        },
        state: "lobby",
        capture: {},
        upload: { error: null, recoverable: false },
        hostSegments: [],
        ...extra,
      }) as unknown as HostRoom;
    let setRoom: (room: HostRoom) => void = () => {};
    function Switchable({ children }: { children: ReactNode }) {
      const [value, set] = useState(waiting());
      useEffect(() => {
        setRoom = set;
      }, [set]);
      return <HostRoomProvider value={value}>{children}</HostRoomProvider>;
    }
    const { result } = renderHook(
      () => {
        renders();
        return useRecordBadge();
      },
      { wrapper: Switchable },
    );
    expect(result.current).toEqual({ kind: "waiting", count: 1 });
    const before = renders.mock.calls.length;
    act(() => setRoom(waiting({ unrelated: 1 })));
    expect(renders).toHaveBeenCalledTimes(before);
    act(() => setRoom(waiting({ state: "paused" })));
    expect(result.current).toEqual({ kind: "paused", alert: false });
    expect(renders.mock.calls.length).toBeGreaterThan(before);
  });
});

describe("useStageBadges pending cuts for a guest", () => {
  const join = (caps: string[]) => {
    useDawStore
      .getState()
      .hydrate(
        "share:tok",
        minimalProject({ pending_edits: [pendingEditView()] }),
        caps.includes("edit") ? "edit" : "comment",
        caps,
      );
  };

  it("counts an Editor's pending cuts, which the stubbed impact reports as zero", () => {
    join(["view", "comment", "edit"]);
    const { result } = renderHook(() => useStageBadges(), {
      wrapper: wrap(room(false)),
    });
    expect(result.current.review).toEqual({ kind: "needs-you", count: 1 });
  });

  it("leaves a Commenter without the count", () => {
    join(["view", "comment"]);
    const { result } = renderHook(() => useStageBadges(), {
      wrapper: wrap(room(false)),
    });
    expect(result.current.review).toBeUndefined();
  });
});
